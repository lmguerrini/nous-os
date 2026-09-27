/** Opt-in visual matrix over a local export. No server or browser is started by the page worker. */
import { test, expect } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve, sep } from "node:path";

type Rect = { left: number; top: number; width: number; height: number };
type Witness = {
  visibleRect: Rect;
  nodeViewport: Record<string, { x: number; y: number }>;
  labels: { id: string; rect: Rect }[];
  selected: string | null;
  emphasised: string[];
  page: { axes: Record<string, unknown>; stackDepth: number; debug: boolean };
};
type API = {
  ready: Promise<void>;
  errors: string[];
  witness(): Witness;
  state(): { axes: Record<string, unknown>; selected: string | null };
  setAxes(axes: Record<string, unknown>): Promise<void>;
  select(id: string): Promise<void>;
  expand(): Promise<void>;
  back(): Promise<void>;
  reset(): Promise<void>;
  fit(): Promise<void>;
  setDebug(on: boolean): Promise<void>;
  openLens(on: boolean): void;
};
const api = () => (window as typeof window & { __d067: API }).__d067;
const inside = (x: number, y: number, r: Rect) =>
  x >= r.left && x <= r.left + r.width && y >= r.top && y <= r.top + r.height;
const overlap = (a: Rect, b: Rect) =>
  a.left < b.left + b.width && a.left + a.width > b.left && a.top < b.top + b.height && a.top + a.height > b.top;

test("D-067 product review matrix", async ({ page }) => {
  test.skip(process.env.D067_VIEWER !== "1", "D067_VIEWER=1 required");
  const shots = process.env.SHOTS_DIR;
  if (!shots) throw new Error("SHOTS_DIR is required");
  const target = resolve(shots),
    repo = resolve("..");
  if (target === repo || target.startsWith(repo + sep)) throw new Error("SHOTS_DIR must be outside the repository");
  await mkdir(target, { recursive: true });
  const url = process.env.REVIEW_URL ?? "http://127.0.0.1:8766";
  const failures: string[] = [];
  page.on("pageerror", (error) => failures.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") failures.push(message.text());
  });
  const metrics: Record<string, unknown> = {},
    timings: Record<string, number> = {};
  const start = performance.now();
  // Functions passed to page.evaluate run in the page, where the Node-side `api` helper does not exist;
  // define the same accessor there before the page script loads.
  await page.addInitScript(() => {
    (window as typeof window & { api?: () => API | undefined }).api = () =>
      (window as typeof window & { __d067?: API }).__d067;
  });
  await page.goto(url);
  await page.waitForFunction(() => !!(window as typeof window & { __d067?: API }).__d067);
  await page.evaluate(() => api().ready);
  timings.readyMs = Math.round(performance.now() - start);
  const exportResponse = await page.request.get(`${url}/api/export.json`);
  const graph = (await exportResponse.json()) as { nodes: { id: string; label: string }[] };
  const card = graph.nodes.find((node) => node.label.replace(/[’‘]/g, "'").startsWith("Atlasfield è l'archivio"));
  expect(card, "named focus card").toBeDefined();
  async function setAxes(axes: Record<string, unknown>) {
    await page.evaluate((next) => api().setAxes(next), axes);
  }
  async function pixels(buffer: Buffer, name: string) {
    return page.evaluate(
      async ({ base64, name }) => {
        const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
        const image = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
        const canvas = new OffscreenCanvas(image.width, image.height),
          context = canvas.getContext("2d")!;
        context.drawImage(image, 0, 0);
        const rgba = context.getImageData(0, 0, image.width, image.height).data;
        const win = window as typeof window & { __d067Pixels?: Record<string, Uint8ClampedArray> };
        const before = win.__d067Pixels ?? {};
        let chroma = 0,
          nonBlack = 0;
        for (let i = 0; i < rgba.length; i += 4) {
          const r = rgba[i]!,
            g = rgba[i + 1]!,
            b = rgba[i + 2]!;
          // Only clearly lit pixels: faint halo and filament pixels would dilute the colour of the nodes.
          if (Math.max(r, g, b) > 40) {
            chroma += Math.max(r, g, b) - Math.min(r, g, b);
            nonBlack++;
          }
        }
        const differences: Record<string, number> = {};
        for (const [previous, prior] of Object.entries(before))
          if (prior.length === rgba.length) {
            let sum = 0;
            for (let i = 0; i < rgba.length; i += 4)
              sum +=
                (Math.abs(rgba[i]! - prior[i]!) +
                  Math.abs(rgba[i + 1]! - prior[i + 1]!) +
                  Math.abs(rgba[i + 2]! - prior[i + 2]!)) /
                3;
            differences[previous] = sum / (rgba.length / 4);
          }
        win.__d067Pixels = { ...before, [name]: new Uint8ClampedArray(rgba) };
        return {
          meanChroma: chroma / (rgba.length / 4),
          meanChromaLit: chroma / Math.max(1, nonBlack),
          pixelDifference: differences,
        };
      },
      { base64: buffer.toString("base64"), name },
    );
  }
  async function capture(name: string, focus = false) {
    const began = performance.now();
    await page.evaluate(
      () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
    );
    const witness = await page.evaluate(() => api().witness());
    const labels = witness.labels ?? [];
    let overlapping = 0,
      outside = 0;
    for (let i = 0; i < labels.length; i++) {
      const a = labels[i]!.rect;
      if (
        !inside(a.left, a.top, witness.visibleRect) ||
        !inside(a.left + a.width, a.top + a.height, witness.visibleRect)
      )
        outside++;
      for (let j = i + 1; j < labels.length; j++) if (overlap(a, labels[j]!.rect)) overlapping++;
    }
    let selectedCentral = true,
      emphasisedInside = true;
    if (focus) {
      const r = witness.visibleRect,
        p = witness.selected ? witness.nodeViewport[witness.selected] : undefined;
      selectedCentral =
        !!p &&
        inside(p.x, p.y, {
          left: r.left + r.width * 0.2,
          top: r.top + r.height * 0.2,
          width: r.width * 0.6,
          height: r.height * 0.6,
        });
      emphasisedInside = witness.emphasised.every((id) => {
        const point = witness.nodeViewport[id];
        return !!point && inside(point.x, point.y, r);
      });
    }
    const canvas = await page.locator("#viewport").screenshot();
    await page.screenshot({ path: resolve(target, `${name}.png`) });
    const colour = await pixels(canvas, name);
    const metric = { overlapping, outside, selectedCentral, emphasisedInside, ...colour };
    metrics[name] = metric;
    timings[name] = Math.round(performance.now() - began);
    await writeFile(resolve(target, `${name}.json`), JSON.stringify(witness, null, 2) + "\n");
    await writeFile(resolve(target, "metrics.json"), JSON.stringify({ metrics, timings }, null, 2) + "\n");
    expect(overlapping, `${name} label overlap`).toBe(0);
    expect(outside, `${name} label outside`).toBe(0);
    if (focus) {
      expect(selectedCentral, `${name} centred selection`).toBe(true);
      expect(emphasisedInside, `${name} visible focus`).toBe(true);
    }
    return metric;
  }
  const one = await capture("01-bw-stellar-flat-2d");
  await setAxes({ organization: "indra", projection: "3d-perspective" });
  const two = await capture("02-bw-stellar-indra-3d");
  await setAxes({ organization: "flat", morphology: "neural" });
  const three = await capture("03-bw-neural-flat-3d");
  await setAxes({ morphology: "mycelium" });
  const four = await capture("04-bw-mycelium-flat-3d");
  await setAxes({ projection: "2d", morphology: "stellar" });
  await page.evaluate((id) => api().select(id), card!.id);
  const point = await page.evaluate((id) => api().witness().nodeViewport[id], card!.id);
  expect(point).toBeDefined();
  await page.mouse.click(point!.x, point!.y);
  await expect.poll(() => page.evaluate(() => api().state().selected)).toBe(card!.id);
  await capture("05-focus-2d", true);
  await setAxes({ projection: "3d-focus" });
  await capture("06-focus-3d", true);
  await setAxes({ colour: "semantic" });
  const seven = await capture("07-semantic-colour", true);
  await page.evaluate(() => api().setDebug(true));
  await capture("08-provenance-debug");
  await page.evaluate(() => api().setDebug(false));
  await page.evaluate(() => api().openLens(true));
  await capture("09-lens-popover");
  await page.evaluate(() => api().openLens(false));
  const hover = await page.evaluate((id) => api().witness().nodeViewport[id], card!.id);
  if (hover) await page.mouse.move(hover.x, hover.y);
  await capture("10-hover-label");
  await setAxes({ labels: false });
  await capture("11-labels-off");
  await page.evaluate(() => api().reset());
  await setAxes({ projection: "2d", colour: "bw", labels: true, organization: "flat", morphology: "stellar" });
  await capture("12-flat-2d");
  await setAxes({ organization: "indra" });
  const indra = await capture("12-indra-2d");
  await setAxes({ organization: "flat", morphology: "neural" });
  await capture("13-neural-2d");
  await setAxes({ morphology: "mycelium" });
  await capture("14-mycelium-2d");
  await page.evaluate((id) => api().select(id), card!.id);
  await page.evaluate(() => api().expand());
  await capture("15-expanded", true);
  await page.evaluate(() => api().back());
  await capture("16-back", true);
  await writeFile(resolve(target, "metrics.json"), JSON.stringify({ metrics, timings }, null, 2) + "\n");
  expect((one as { meanChroma: number }).meanChroma).toBeLessThan(2);
  expect((seven as { meanChroma: number }).meanChroma).toBeGreaterThan(
    (one as { meanChroma: number }).meanChroma + 0.05,
  );
  expect((seven as { meanChromaLit: number }).meanChromaLit).toBeGreaterThan(
    Math.max(2, 3 * (one as { meanChromaLit: number }).meanChromaLit),
  );
  expect(
    (three as { pixelDifference: Record<string, number> }).pixelDifference["04-bw-mycelium-flat-3d"] ??
      (four as { pixelDifference: Record<string, number> }).pixelDifference["03-bw-neural-flat-3d"],
  ).toBeGreaterThan(0.2);
  expect((indra as { pixelDifference: Record<string, number> }).pixelDifference["12-flat-2d"]).toBeGreaterThan(0.2);
  expect((two as { pixelDifference: Record<string, number> }).pixelDifference["01-bw-stellar-flat-2d"]).toBeGreaterThan(
    0.2,
  );
  expect(failures).toEqual([]);
  expect(await page.evaluate(() => api().errors)).toEqual([]);
  await writeFile(resolve(target, "metrics.json"), JSON.stringify({ metrics, timings }, null, 2) + "\n");
});
