import { expect, test, type Page } from "@playwright/test";
import { waitForCameraRest } from './camera-rest.ts';

test.skip(process.env.D072_BROWSER !== "1", "Serve the review page with D072_BROWSER=1");
const url = process.env.D072_URL ?? "http://127.0.0.1:8768/";

/** All data here is invented; no store endpoint is read by this spec. */
const nodes = Array.from({ length: 32 }, (_, index) => ({
  id: `fixture:domain:${index}`, level: 1, kind: "domain", parent: null, parents: [],
  domains: [`fixture:${index}`], title: `Invented domain ${index}`, title_full: `Invented domain ${index}`,
  size: 0.3, importance: { value: 1 + index / 100, components: {} },
  counts: { children: 0, descendants: 0, canon: 0, passages: 0 },
}));
const edges = [
  ...Array.from({ length: 31 }, (_, index) => ({ id: `fixture:attested:${index}`,
    source: nodes[index]!.id, target: nodes[index + 1]!.id, class: "attested", type: "association",
    directed: false, evidence: [] })),
  { id: "fixture:exploratory", source: nodes[0]!.id, target: nodes[16]!.id,
    class: "exploratory", type: "association", directed: true, evidence: [],
    explanation: "An invented connection for rendering checks.", status: "exploratory/non-canonical" },
];

async function ready(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.route("**/api/graph/manifest", route => route.fulfill({ json: {
    schema: "nousos.review-graph/2", digest: "fixture-d072-perf", counts: { level: { 1: nodes.length } }, limits: {},
  } }));
  await page.route("**/api/graph/index", route => route.fulfill({ json: { schema: "nousos.review-graph/2", nodes, edges } }));
  await page.route("**/api/graph/node?*", route => route.fulfill({ json: { node: nodes[0], detail: {}, relations: [] } }));
  await page.goto(url);
  await page.evaluate(() => (window as any).__d067.ready);
  await page.evaluate(() => (window as any).__d067.setAxes({
    projection: "2d", organization: "flat", morphology: "stellar", reading: "attested", labels: false,
  }));
  await expect(page.locator("#viewport canvas[data-morphology-canvas]")).toBeVisible();
}

test("D072 settled attested scene does no 2D work; exploratory repaint stays on the small flow layer", async ({ page }) => {
  await page.addInitScript(() => {
    const state = { counts: {} as Record<string, number>, reset() { this.counts = {}; } };
    (window as any).__d072Ops = state;
    const names = ["clearRect", "fillRect", "strokeRect", "beginPath", "moveTo", "lineTo", "bezierCurveTo",
      "quadraticCurveTo", "arc", "ellipse", "fill", "stroke", "drawImage", "putImageData", "fillText", "strokeText"];
    for (const name of names) {
      const original = (CanvasRenderingContext2D.prototype as any)[name];
      if (typeof original !== "function") continue;
      Object.defineProperty(CanvasRenderingContext2D.prototype, name, { configurable: true, value: function (...args: unknown[]) {
        const canvas = (this as CanvasRenderingContext2D).canvas;
        const id = canvas.dataset.flowCanvas ? "flow" : canvas.dataset.morphologyCanvas ? "morphology"
          : canvas.className || canvas.id || "other";
        state.counts[id] = (state.counts[id] ?? 0) + 1;
        return original.apply(this, args);
      } });
    }
  });
  await ready(page);
  await page.waitForTimeout(700);
  await page.evaluate(() => (window as any).__d072Ops.reset());
  await page.waitForTimeout(2000);
  const still = await page.evaluate(() => ({ ...(window as any).__d072Ops.counts })) as Record<string, number>;
  expect(Object.values(still).reduce((sum, count) => sum + count, 0)).toBe(0);

  const fullSceneOps = await page.evaluate(() => {
    (window as any).__d072Ops.reset();
    (document.querySelector("#viewport canvas[data-morphology-canvas]") as HTMLCanvasElement & { __morphRedraw?: () => void }).__morphRedraw?.();
    return (window as any).__d072Ops.counts.morphology ?? 0;
  }) as number;
  expect(fullSceneOps).toBeGreaterThan(0);
  await page.evaluate(() => (window as any).__d067.setAxes({ reading: "exploratory" }));
  await page.waitForTimeout(350);
  await page.evaluate(() => (window as any).__d072Ops.reset());
  await page.waitForTimeout(1000);
  const animated = await page.evaluate(() => ({ ...(window as any).__d072Ops.counts })) as Record<string, number>;
  expect(animated.flow ?? 0).toBeGreaterThan(0);
  expect(Object.entries(animated).filter(([name, count]) => name !== "flow" && count > 0)).toEqual([]);
  const flowFrames = await page.evaluate(() => (window as any).__d072.flowFps()) as number;
  expect((animated.flow ?? 0) / Math.max(1, flowFrames)).toBeLessThan(fullSceneOps * 0.05);
});

test("D072 quality recovers after drag and performance overlay opens, samples and closes", async ({ page }) => {
  await ready(page);
  const box = (await page.locator("#viewport").boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.65, box.y + box.height * 0.6, { steps: 5 });
  expect(await page.evaluate(() => (window as any).__d072.quality())).toBe("moving");
  await page.mouse.up();
  await waitForCameraRest(page);
  await expect.poll(() => page.evaluate(() => (window as any).__d072.quality()), { timeout: 400, intervals: [50] }).toBe("full");

  const opener = page.locator("#performance-toggle");
  const surface = page.locator("#performance-overlay");
  await page.locator('#more-menu summary').click();
  await opener.click();
  await expect(surface).toBeVisible();
  await expect(opener).toHaveAttribute("aria-pressed", "true");
  const rects = await page.evaluate(() => {
    const a = document.getElementById("performance-overlay")!.getBoundingClientRect();
    const b = document.getElementById("panel-edge-toggle")!.getBoundingClientRect();
    return { overlayBottom: a.bottom, panelTop: b.top };
  });
  expect(rects.overlayBottom).toBeLessThanOrEqual(rects.panelTop);
  await page.waitForTimeout(600);
  const perf = await page.evaluate(() => (window as any).__d072.perf());
  expect(perf.fps.median).toBeGreaterThan(0);
  expect(perf.frameTime.p95).toBeGreaterThan(0);
  expect(perf.nodes.rendered).toBeGreaterThan(0);
  expect(perf.arcs.available).toBeGreaterThanOrEqual(0);
  expect(perf.labels).toBeGreaterThanOrEqual(0);
  expect(perf.quality).toBe("piena");
  expect(perf.dpr).toBeGreaterThan(0);
  expect(perf.canvases.length).toBeGreaterThan(0);
  await expect(surface).toContainText(/FPS|Frame time|Nodi|Archi|Etichette|Qualità|DPR/);
  await opener.click();
  await expect(surface).toBeHidden();
  await opener.click();
  await surface.locator(".surface-close").click();
  await expect(surface).toBeHidden();
  await opener.click();
  await page.keyboard.press("Escape");
  await expect(surface).toBeHidden();
});

test("D072 2D unused Sigma layers are 1×1 and hover and click still reach a node", async ({ page }) => {
  await ready(page);
  const canvases = await page.evaluate(() => (window as any).__d072.perf().canvases);
  for (const layer of ["sigma-labels", "sigma-edgeLabels", "sigma-hovers", "sigma-hoverNodes", "sigma-mouse"]) {
    const canvas = canvases.find((item: { id: string }) => item.id === layer);
    expect(canvas, layer).toBeTruthy();
    expect([canvas.width, canvas.height], layer).toEqual([1, 1]);
  }
  const target = await page.evaluate(() => {
    const points = (window as any).__d067.witness().nodeViewport;
    return Object.entries(points).map(([id, point]) => ({ id, ...(point as object) }))
      .find((point: any) => point.x > 100 && point.y > 100 && point.x < innerWidth - 100 && point.y < innerHeight - 100);
  }) as { id: string; x: number; y: number } | undefined;
  expect(target).toBeTruthy();
  await page.mouse.move(target!.x, target!.y);
  await expect(page.locator("#viewport")).not.toHaveAttribute("title", "");
  await page.mouse.click(target!.x, target!.y);
  await expect.poll(() => page.evaluate(() => (window as any).__d067.state().selected)).toBe(target!.id);
});

test("D072 hidden 3D GPU tier uses a one-pixel-ratio backing store", async ({ page }) => {
  await ready(page);
  await page.evaluate(() => (window as any).__d067.setAxes({ projection: "3d" }));
  const canvas = await page.evaluate(() => (window as any).__d072.perf().canvases
    .find((item: { id: string }) => item.id === "three"));
  expect(canvas).toBeTruthy();
  expect(canvas.dpr).toBeCloseTo(1, 1);
  expect(canvas.width).toBeCloseTo(canvas.cssWidth, 0);
  expect(canvas.height).toBeCloseTo(canvas.cssHeight, 0);
});
