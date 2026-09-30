import { expect, type Page } from '@playwright/test';

export const D074_URL = process.env.D074_URL;
export const VIEWPORT = { width: 1440, height: 1000 };
export type Witness = {
  revision: number;
  camera: { zoom: number; band: string; settled: boolean };
  focus: { clusterId: string | null; source: string | null; epoch: number };
  levels: Record<string, number>;
  nodes: Record<string, number>;
  renderedNodeIds: string[];
  aggregates: { id: string; memberCount: number; explanationId?: string }[];
  edges: { drawn: { id: string; from: { id: string }; to: { id: string }; count?: number }[]; budget: number };
  invariant: { ok: boolean; violations: unknown[] };
  exclusions: Record<string, string>;
};

export async function ready(page: Page, target = D074_URL): Promise<void> {
  if (!target) throw new Error('D074_URL is required when D074_BROWSER=1');
  await page.setViewportSize(VIEWPORT);
  await page.goto(target, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => Boolean((window as any).__d067?.ready));
  await page.evaluate(async () => { await (window as any).__d067.ready; });
  await stable(page);
}

export async function stable(page: Page): Promise<Witness> {
  return page.evaluate(async () => {
    const api = (window as any).__d074;
    if (!api?.revealWitness) throw new Error('window.__d074.revealWitness() is unavailable');
    let previous = '';
    let matches = 0;
    for (let i = 0; i < 100; i += 1) {
      const witness = api.revealWitness();
      const signature = JSON.stringify([witness.revision, witness.camera, witness.focus, witness.levels, witness.nodes, witness.renderedNodeIds, witness.aggregates, witness.edges]);
      matches = signature === previous ? matches + 1 : 0;
      if (matches >= 2) return witness;
      previous = signature;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    return api.revealWitness();
  });
}

export async function setAxes(page: Page, axes: Record<string, unknown>): Promise<Witness> {
  await page.evaluate(async value => { await (window as any).__d067.setAxes(value); }, axes);
  return stable(page);
}

export async function fit(page: Page): Promise<Witness> {
  await page.evaluate(() => (window as any).__d067.fit());
  return stable(page);
}

export async function hub(page: Page): Promise<{ id: string; x: number; y: number; box: { x: number; y: number; width: number; height: number } }> {
  const box = await page.locator('#viewport').boundingBox();
  expect(box, '#viewport is present').not.toBeNull();
  const node = await page.evaluate(() => {
    const entries = Object.entries((window as any).__d067.witness().nodeViewport ?? {}) as [string, any][];
    const domains = entries.filter(([id, p]) => id.startsWith('domain:') && Number.isFinite(p?.x) && Number.isFinite(p?.y));
    domains.sort((a, b) => (b[1].radius ?? 0) - (a[1].radius ?? 0) || a[0].localeCompare(b[0]));
    return domains[0] ? { id: domains[0][0], x: domains[0][1].x, y: domains[0][1].y } : null;
  });
  // nodeViewport points are page (client) coordinates, the frame the mouse moves in.
  return { id: node?.id ?? '', x: node?.x ?? box!.x + box!.width / 2, y: node?.y ?? box!.y + box!.height / 2, box: box! };
}

export async function wheel(page: Page, point: { x: number; y: number }, delta: number, count = 1): Promise<Witness> {
  await page.mouse.move(point.x, point.y);
  for (let i = 0; i < count; i += 1) {
    await page.mouse.wheel(0, delta);
    await page.waitForTimeout(220);
  }
  return stable(page);
}

export const cameraState = (page: Page) => page.evaluate(() => (window as any).__d067.cameraState());
export const nodeViewport = (page: Page) => page.evaluate(() => (window as any).__d067.witness().nodeViewport as Record<string, { x: number; y: number; radius?: number }>);

export function descendantIds(page: Page, clusterId: string): Promise<string[]> {
  return page.evaluate(id => {
    const items = (window as any).__d067.witness().disclosure?.nodes ?? [];
    const children = new Map<string, string[]>();
    for (const item of items) if (item.parent) children.set(String(item.parent), [...(children.get(String(item.parent)) ?? []), String(item.id)]);
    const result = new Set<string>([id]);
    const pending = [id];
    while (pending.length) for (const child of children.get(pending.pop()!) ?? []) if (!result.has(child)) { result.add(child); pending.push(child); }
    return [...result];
  }, clusterId);
}

export async function focusedRendered(page: Page, witness: Witness): Promise<number> {
  const clusterId = witness.focus.clusterId;
  if (!clusterId) return 0;
  const descendants = new Set(await descendantIds(page, clusterId));
  const rendered = witness.renderedNodeIds.filter(id => descendants.has(String(id))).length;
  const aggregateMembers = witness.aggregates.filter(item => descendants.has(String(item.id))).reduce((n, item) => n + Number(item.memberCount ?? 0), 0);
  return rendered + aggregateMembers;
}

export function verifyEdges(witness: Witness): string[] {
  const visible = new Set([...witness.renderedNodeIds.map(String), ...witness.aggregates.map(item => String(item.id))]);
  const problems: string[] = [];
  for (const edge of witness.edges.drawn) {
    for (const endpoint of ['from', 'to'] as const) {
      const id = String(edge[endpoint]?.id);
      if (!visible.has(id)) problems.push(`${edge.id}/${endpoint}:${id} is not rendered or represented by an aggregate`);
    }
  }
  return problems;
}

export async function viewportPixels(page: Page): Promise<{ width: number; height: number; data: Buffer }> {
  const png = await page.locator('#viewport').screenshot({ animations: 'disabled' });
  const { decodePng } = await import('./png-codec.ts');
  return decodePng(png, '#viewport screenshot');
}

export function pixelDifference(a: { width: number; height: number; data: Buffer }, b: { width: number; height: number; data: Buffer }): number {
  if (a.width !== b.width || a.height !== b.height) return 1;
  let different = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    if (Math.abs(a.data[i]! - b.data[i]!) + Math.abs(a.data[i + 1]! - b.data[i + 1]!) + Math.abs(a.data[i + 2]! - b.data[i + 2]!) > 18) different += 1;
  }
  return different / (a.width * a.height);
}
