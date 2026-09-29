import { expect, test } from '@playwright/test';
import { waitForCameraRest } from './camera-rest.ts';

test.skip(process.env.D072_BROWSER !== '1', 'Serve the review page with D072_BROWSER=1');
const url = process.env.D072_URL ?? 'http://127.0.0.1:8768/';

const scene = (page: import('@playwright/test').Page) => page.evaluate(() => {
  const api = (window as any).__d067;
  const witness = api.witness();
  return { focus: witness.focus, nodes: Object.keys(witness.nodeViewport).sort(),
    arcs: witness.relations.map((edge: { id: string }) => edge.id).sort(),
    disclosed: api.disclosure().visible, camera: api.cameraState() };
});

test('D072 domain focus dims context, keeps disclosure and exits with Escape', async ({ page }) => {
  await page.goto(url);
  await page.evaluate(() => (window as any).__d067.ready);
  await expect(page.locator('#status')).toContainText('Grafo pronto');
  await page.evaluate(() => (window as any).__d067.setAxes({ projection: '2d', organization: 'flat', reading: 'attested' }));
  const domain = await page.evaluate(() => (window as any).__d067.disclosure().nodes.find((node: { level: number }) => node.level === 1)?.id);
  expect(domain).toBeTruthy();
  await page.evaluate(id => (window as any).__d067.expand(id), domain);
  const before = await scene(page);
  await page.evaluate(id => (window as any).__d067.select(id), domain);
  await waitForCameraRest(page);
  const focused = await scene(page);
  expect(focused.focus.id).toBe(domain);
  expect(focused.focus.members).toContain(domain);
  expect(focused.focus.members.length).toBeGreaterThan(1);
  expect(focused.focus.dimmed.length).toBeGreaterThan(0);
  expect(focused.nodes.length).toBeLessThanOrEqual(before.nodes.length);
  expect(focused.disclosed).toBe(before.disclosed);
  await expect(page.locator('#selection-focus-chip')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('#selection-focus-chip')).toBeHidden();
  expect((await scene(page)).focus).toBeNull();
});

test('D072 Solo vicinato shows exact one/two hop node sets and restores camera and set', async ({ page }) => {
  await page.goto(url);
  await page.evaluate(() => (window as any).__d067.ready);
  await expect(page.locator('#status')).toContainText('Grafo pronto');
  await page.evaluate(() => (window as any).__d067.setAxes({ projection: '3d', organization: 'indra', reading: 'attested' }));
  const domain = await page.evaluate(() => (window as any).__d067.disclosure().nodes.find((node: { level: number }) => node.level === 1)?.id);
  await page.evaluate(id => (window as any).__d067.expand(id), domain);
  await page.evaluate(id => (window as any).__d067.select(id), domain);
  await waitForCameraRest(page);
  const before = await scene(page);
  const expected = await page.evaluate(async (id) => {
    const index = await (await fetch('/api/graph/index')).json();
    const disclosed = (window as any).__d067.disclosure().nodes as Array<{ id: string; parent: string | null }>;
    const allowed = new Set(disclosed.map(node => node.id));
    const byId = new Map(disclosed.map(node => [node.id, node]));
    const members = new Set<string>([id]);
    for (const node of disclosed) {
      let parent = node.parent;
      while (parent) {
        if (parent === id) { members.add(node.id); break; }
        parent = byId.get(parent)?.parent ?? null;
      }
      if (index.nodes.find((item: { id: string }) => item.id === node.id)?.domains?.includes(id)) members.add(node.id);
    }
    const links = new Map<string, Set<string>>();
    const add = (a: string, b: string) => {
      if (!allowed.has(a) || !allowed.has(b)) return;
      if (!links.has(a)) links.set(a, new Set());
      if (!links.has(b)) links.set(b, new Set());
      links.get(a)!.add(b); links.get(b)!.add(a);
    };
    for (const edge of index.edges) if (edge.class === 'attested') add(edge.source, edge.target);
    for (const node of disclosed) if (node.parent) add(node.id, node.parent);
    const result: string[][] = [];
    const seen = new Set(members);
    let frontier = [...seen];
    for (let hop = 0; hop < 2; hop++) {
      const next: string[] = [];
      for (const current of frontier) for (const neighbour of links.get(current) ?? [])
        if (!seen.has(neighbour)) { seen.add(neighbour); next.push(neighbour); }
      frontier = next;
      result.push([...seen].sort());
    }
    return result;
  }, domain);
  await page.locator('#neighbourhood-control button[data-depth="1"]').click();
  const one = await scene(page);
  expect(one.focus.neighbourhood.depth).toBe(1);
  expect(one.nodes).toEqual(expected[0]);
  const count = (value: number) => new Intl.NumberFormat('it-IT', { useGrouping: 'always' }).format(value);
  await expect(page.locator('#neighbourhood-count')).toHaveText(`Vicinato: ${count(one.nodes.length)} nodi · ${count(one.arcs.length)} archi`);
  await page.locator('#neighbourhood-control button[data-depth="2"]').click();
  const two = await scene(page);
  expect(two.focus.neighbourhood.depth).toBe(2);
  expect(two.nodes).toEqual(expected[1]);
  await expect(page.locator('#neighbourhood-count')).toHaveText(`Vicinato: ${count(two.nodes.length)} nodi · ${count(two.arcs.length)} archi`);
  await page.locator('#neighbourhood-control button[data-depth="off"]').click();
  const restored = await scene(page);
  expect(restored.nodes).toEqual(before.nodes);
  expect(restored.arcs).toEqual(before.arcs);
  expect(restored.camera).toEqual(before.camera);
  expect(restored.focus.neighbourhood).toBeNull();
});
