import { expect, test } from "@playwright/test";

test.skip(process.env.D072_BROWSER !== "1", "Serve the review page with D072_BROWSER=1");
const url = process.env.D072_URL ?? "http://127.0.0.1:8768/";
const nodes = Array.from({ length: 8 }, (_, index) => ({
  id: `fixture:domain:${index}`, level: 1, kind: "domain", parent: null, parents: [],
  domains: [`fixture:${index}`], title: `Invented domain ${index}`, title_full: `Invented domain ${index}`,
  size: 0.3, importance: { value: 1 + index / 100, components: {} },
  counts: { children: 0, descendants: 0, canon: 0, passages: 0 },
}));
const edges = [
  ...Array.from({ length: 7 }, (_, index) => ({
    id: `fixture:attested:${index}`, source: nodes[index]!.id, target: nodes[index + 1]!.id,
    class: "attested", type: "association", directed: false, evidence: [],
  })),
  { id: "fixture:exploratory", source: nodes[0]!.id, target: nodes[4]!.id,
    class: "exploratory", type: "association", directed: true, evidence: [],
    explanation: "Invented relation", status: "exploratory/non-canonical" },
];

test("D-072 view switches retain one visible morphology canvas", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.route("**/api/graph/manifest", route => route.fulfill({ json: {
    schema: "nousos.review-graph/2", digest: "fixture-d072-switch", counts: { level: { 1: nodes.length } }, limits: {},
  } }));
  await page.route("**/api/graph/index", route => route.fulfill({ json: { schema: "nousos.review-graph/2", nodes, edges } }));
  await page.route("**/api/graph/node?*", route => route.fulfill({ json: { node: nodes[0], detail: {}, relations: [] } }));
  await page.goto(url);
  await page.evaluate(() => (window as any).__d067.ready);
  await expect(page.locator("#status")).toContainText("Grafo pronto");

  const assertCanvas = async (step: string) => {
    const canvases = page.locator("#render-root canvas[data-morphology-canvas]");
    await expect(canvases, `${step}: exactly one live morphology canvas`).toHaveCount(1);
    await expect(canvases, `${step}: canvas is visible`).toBeVisible();
    const box = await canvases.boundingBox();
    expect(box?.width, `${step}: canvas has width`).toBeGreaterThan(0);
    expect(box?.height, `${step}: canvas has height`).toBeGreaterThan(0);
    await expect(page.locator("#render-root .view-host"), `${step}: one view host`).toHaveCount(1);
  };

  await assertCanvas("initial");
  for (const [step, axes] of [
    ["reading", { reading: "combined" }],
    ["morphology", { morphology: "neural" }],
    ["projection", { projection: "3d" }],
    ["organization", { organization: "indra" }],
    ["morphology again", { morphology: "mycelium" }],
    ["projection again", { projection: "2d" }],
  ] as const) {
    await page.evaluate(value => (window as any).__d067.setAxes(value), axes);
    await assertCanvas(step);
  }
});
