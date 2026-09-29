import { expect, test, type Page } from "@playwright/test";
import { writeFile } from "node:fs/promises";

const url = process.env.D072_URL ?? "http://127.0.0.1:8768/";
test.skip(process.env.D072_BROWSER !== "1", "Set D072_BROWSER=1 and serve the review page");

/** The budgets, mirrored from src/review/lod.ts for an independent check. */
const BUDGETS = {
  essential: { nodes: 150, arcs: 150, labels: 20, labelCapNow: 60 },
  balanced: { nodes: 400, arcs: 450, labels: 40, labelCapNow: 60 },
  complete: { nodes: 850, arcs: 1200, labels: 60, labelCapNow: 60 },
} as const;

type LodWitness = {
  level: string;
  density: string;
  nodes: { rendered: number; available: number; pinned: number; pinnedIds: string[] };
  arcs: { rendered: number; available: number; pinned: number; pinnedIds: string[] };
  relations?: Array<{ id: string; source: string; target: string }>;
  focus?: { id?: string } | null;
  labels: { rendered: number; available: number };
};

const ready = async (page: Page) => {
  await page.goto(url);
  await page.evaluate(() => (window as any).__d067.ready);
  await expect(page.locator("#status")).toContainText("Grafo pronto");
};

const lod = (page: Page) => page.evaluate(() => {
  const witness = (window as any).__d067.witness();
  return { ...witness.lod, relations: witness.relations, focus: witness.focus };
}) as Promise<LodWitness>;

/** The rendered node set, as the view draws it. */
const renderedIds = (page: Page) => page.evaluate(() =>
  Object.keys((window as any).__d067.witness().nodeViewport ?? {}).sort()) as Promise<string[]>;

/** Disclose enough of the graph that every node budget binds: expand each domain, then its projects. */
const disclose = async (page: Page) => {
  const ids = await page.evaluate(() => (window as any).__d067.disclosure().nodes
    .filter((node: { level: number }) => node.level === 1)
    .map((node: { id: string }) => node.id));
  for (const id of ids) await page.evaluate((domain) => (window as any).__d067.expand(domain), id);
  for (let round = 0; round < 2; round += 1) {
    const projects = await page.evaluate(() => (window as any).__d067.disclosure().nodes
      .filter((node: { level: number }) => node.level === 2)
      .slice(0, 6)
      .map((node: { id: string }) => node.id));
    for (const id of projects) await page.evaluate((project) => (window as any).__d067.expand(project), id);
  }
};

/** One wheel notch; the level is evaluated on a 250 ms page tick, so settle before reading.
 * A level change rebuilds the view, and for a moment no canvas exists at all — the box is
 * polled until the new view mounts instead of crashing on the recreation window. */
const notch = async (page: Page, direction: 1 | -1, settle = 400) => {
  const viewport = page.locator("#viewport");
  let box = await viewport.boundingBox();
  for (let attempt = 0; !box && attempt < 100; attempt += 1) {
    await page.waitForTimeout(50);
    box = await viewport.boundingBox();
  }
  if (!box) throw new Error("the viewport canvas never came back after the refresh");
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
  await page.mouse.wheel(0, -direction * 120);
  await page.waitForTimeout(settle);
};

/** render-schedule.ts defers level refresh by LOD_REFRESH_IDLE_MS (300 ms), observed on the
 * page's 250 ms zoom tick. Poll after a crossing sequence because one notch's 400 ms settle
 * can finish before both scheduling intervals have elapsed. */
const waitForLevel = async (page: Page, expected: string) => {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    if ((await lod(page)).level === expected) return;
    await page.waitForTimeout(50);
  }
};

test("D-072 each density keeps its node, arc and label budgets", async ({ page }, testInfo) => {
  await ready(page);
  await page.evaluate(() => (window as any).__d067.setAxes({
    projection: "2d", organization: "flat", reading: "attested", morphology: "stellar",
  }));
  await disclose(page);
  await page.waitForTimeout(1100); // the page holds zoom reveals briefly after a refresh

  // The explicit set L1 pins beyond the budget: the selection's path, the hovered focus, and
  // every child of a node expanded by hand. This spec selects and hovers nothing, so the pins
  // here are exactly the expansion structure it built itself.
  const disclosureState = await page.evaluate(() => {
    const state = (window as any).__d067.disclosure();
    return {
      expanded: state.expanded as string[],
      nodes: state.nodes as Array<{ id: string; parent?: string }>,
    };
  });
  const allowedPinned = new Set<string>(disclosureState.expanded);
  for (const node of disclosureState.nodes)
    if (node.parent && disclosureState.expanded.includes(node.parent)) allowedPinned.add(node.id);

  const results: Record<string, LodWitness & { panel: string }> = {};
  const order = ["essential", "balanced", "complete", "balanced"] as const;
  for (const density of order) {
    await page.evaluate((value) => (window as any).__d067.setDensity(value), density);
    await page.waitForTimeout(1100);
    const witness = await lod(page);
    const budget = BUDGETS[density as keyof typeof BUDGETS];
    expect(witness.density, `density setting took effect`).toBe(density);
    expect(witness.nodes.available, "the disclosed set is large enough to bind the budgets").toBeGreaterThan(budget.nodes);
    // The budget binds on the unpinned fill; pinned children of manual expansions are accounted
    // for explicitly, so the rule is testable rather than an invisible exception.
    expect(witness.nodes.pinned, `${density}: the pinned set is counted`).toBeGreaterThan(0);
    expect(witness.nodes.rendered, `${density}: nodes ≤ ${budget.nodes} + pinned`).toBeLessThanOrEqual(budget.nodes + witness.nodes.pinned);
    for (const id of witness.nodes.pinnedIds)
      expect(allowedPinned.has(id), `${density}: pinned ${id} is an expansion child or an expanded node`).toBe(true);
    expect(witness.arcs.rendered, `${density}: arcs ≤ ${budget.arcs} + pinned`).toBeLessThanOrEqual(budget.arcs + witness.arcs.pinned);
    expect(witness.arcs.pinned, `${density}: forced arcs are counted`).toBe(witness.arcs.pinnedIds.length);
    const pinnedNodes = new Set([...allowedPinned, ...witness.nodes.pinnedIds]);
    const renderedRelations = new Map((witness.relations ?? []).map(arc => [arc.id, arc]));
    for (const id of witness.arcs.pinnedIds) {
      const arc = renderedRelations.get(id);
      const selectedRelation = witness.focus?.id === id;
      expect(selectedRelation || (!!arc && (pinnedNodes.has(arc.source) || pinnedNodes.has(arc.target))),
        `${density}: pinned arc ${id} is incident to a pinned/expanded node or is the selected relation`).toBe(true);
    }
    // The per-density label allowance is the page's own truth and the view honours it at draw
    // time (FixA: product-view places labels within ViewInput.labelBudget).
    expect(witness.labels.available, `${density}: label allowance`).toBe(budget.labels);
    expect(witness.labels.rendered, `${density}: labels within the density allowance`).toBeLessThanOrEqual(budget.labels);
    const panel = await page.locator("#v2-controls").innerText();
    expect(panel, `${density}: the panel names the node budget`).toContain("Nodi");
    expect(panel, `${density}: the panel names the arc budget`).toContain("Archi");
    expect(panel, `${density}: the arc line reports its pinned count`).toContain("fissati");
    expect(panel, `${density}: the panel shows the available wording`).toContain("disponibili");
    expect(panel, `${density}: the panel names the density`).toContain(
      density === "essential" ? "Essenziale" : density === "balanced" ? "Bilanciata" : "Completa");
    if (density !== "balanced" || !results.balanced)
      results[density] = { ...witness, panel: panel.replace(/\n/g, " | ") };
  }

  // Completa shows strictly more than Essenziale when the budget binds.
  expect(results.complete!.nodes.rendered, "completa renders more nodes than essenziale").toBeGreaterThan(results.essential!.nodes.rendered);

  // The selector reflects the state, and the choice survives a reload.
  await page.click('#density-control button[data-density="essential"]');
  await page.waitForTimeout(1100);
  expect(await lod(page).then(w => w.density)).toBe("essential");
  await page.reload();
  await ready(page);
  expect(await lod(page).then(w => w.density), "the density persists across a reload").toBe("essential");

  // The budget also has to bind on a disclosed set built without any manual expansion — semantic
  // zoom alone. The reload left the disclosure history empty, so nothing is pinned by hand here.
  await page.evaluate(() => (window as any).__d067.fit());
  await page.waitForTimeout(1700); // fit suppresses zoom reveals for 1.5 s
  const initial = await lod(page);
  let steps = 0;
  let level = initial.level;
  while (level !== "near" && steps < 40) {
    await notch(page, 1, 350);
    level = (await lod(page)).level;
    steps += 1;
  }
  expect(level, "semantic zoom alone reaches the near level").toBe("near");
  // Stay deep a while: the near level's progressive disclosure adds nodes on its own tick.
  await notch(page, 1, 350);
  await page.waitForTimeout(3000);
  // Leave the canvas before forcing a refresh, so no hover pins anything.
  await page.mouse.move(1, 1);
  await page.waitForTimeout(300);
  await page.evaluate(() => (window as any).__d067.setDensity("balanced"));
  await page.waitForTimeout(1100);
  await page.evaluate(() => (window as any).__d067.setDensity("essential"));
  await page.waitForTimeout(1100);
  const zoomed = await lod(page);
  expect(zoomed.nodes.pinned, "no manual expansions means nothing pinned").toBe(0);
  expect(zoomed.nodes.rendered, "essential: nodes ≤ 150 with no pins to excuse them").toBeLessThanOrEqual(BUDGETS.essential.nodes);
  expect(zoomed.nodes.available, "semantic zoom disclosed nodes on its own").toBeGreaterThan(initial.nodes.available);
  results.zoomOnly = { ...zoomed, panel: "semantic zoom alone" };

  await page.evaluate(() => (window as any).__d067.setDensity("balanced"));
  await writeFile(testInfo.outputPath("lod-budgets.json"), JSON.stringify(results, null, 2));
  console.log(`D-072 budgets: ${Object.entries(results).map(([name, cell]) =>
    `${name} nodes ${cell.nodes.rendered}/${cell.nodes.available} arcs ${cell.arcs.rendered}/${cell.arcs.available} labels ${cell.labels.rendered}/${cell.labels.available}`).join(" | ")}`);
});

test("D-072 zoom levels have hysteresis: a notch of jitter changes nothing, crossing a band does", async ({ page }, testInfo) => {
  await ready(page);
  await page.evaluate(() => (window as any).__d067.setAxes({
    projection: "2d", organization: "flat", reading: "attested", morphology: "stellar",
  }));
  await page.evaluate(() => (window as any).__d067.fit());
  await page.waitForTimeout(1700); // fit suppresses zoom reveals for 1.5 s

  const trace: { step: string; level: string; rendered: number }[] = [];
  const record = async (step: string) => {
    const witness = await lod(page);
    trace.push({ step, level: witness.level, rendered: witness.nodes.rendered });
    return witness;
  };

  // Deep inside far: a full notch in and out changes neither the level nor the rendered set.
  let witness = await record("fit");
  expect(witness.level, "the fitted overview is the far level").toBe("far");
  const before = await renderedIds(page);
  await notch(page, 1);
  await notch(page, -1);
  witness = await record("jitter@far");
  expect(witness.level).toBe("far");
  expect(await renderedIds(page), "a notch of jitter at far changes no node").toEqual(before);

  // Zoom in notch by notch until the intermediate band is truly crossed (never more than 15).
  let steps = 0;
  while (witness.level === "far" && steps < 15) {
    await notch(page, 1);
    witness = await record(`in-${steps}`);
    steps += 1;
  }
  if (witness.level === "far") await waitForLevel(page, "intermediate");
  witness = await record("settled-intermediate");
  expect(witness.level, "zooming in crosses into intermediate").toBe("intermediate");
  const intermediate = await renderedIds(page);

  // Inside the band, a notch of jitter in either direction changes nothing.
  await notch(page, -1);
  await notch(page, 1);
  witness = await record("jitter@intermediate");
  expect(witness.level, "a notch back does not leave intermediate").toBe("intermediate");
  expect(await renderedIds(page), "a notch of jitter inside the band changes no node").toEqual(intermediate);

  // Zooming back out below the exit threshold returns to far.
  steps = 0;
  while (witness.level === "intermediate" && steps < 15) {
    await notch(page, -1);
    witness = await record(`out-${steps}`);
    steps += 1;
  }
  if (witness.level === "intermediate") await waitForLevel(page, "far");
  witness = await record("settled-far");
  expect(witness.level, "zooming out past the band returns to far").toBe("far");

  // And on: enough notches reach the near level, where the focus neighbourhood leads.
  steps = 0;
  while (witness.level !== "near" && steps < 25) {
    await notch(page, 1);
    witness = await record(`deep-${steps}`);
    steps += 1;
  }
  if (witness.level !== "near") await waitForLevel(page, "near");
  witness = await record("settled-near");
  expect(witness.level, "deep zoom reaches the near level").toBe("near");

  await page.evaluate(() => (window as any).__d067.fit());
  await page.waitForTimeout(1700);
  witness = await record("refit");
  expect(witness.level, "the refit returns to far").toBe("far");
  await writeFile(testInfo.outputPath("lod-hysteresis.json"), JSON.stringify(trace, null, 2));
  console.log(`D-072 hysteresis: ${trace.map(entry => `${entry.step}:${entry.level}(${entry.rendered})`).join(" → ")}`);
});

test("D-072 changing density never moves a node that stays visible", async ({ page }) => {
  await ready(page);
  await page.evaluate(() => (window as any).__d067.setAxes({
    projection: "2d", organization: "flat", reading: "attested", morphology: "stellar",
  }));
  await disclose(page);
  await page.evaluate(() => (window as any).__d067.setDensity("balanced"));
  await page.waitForTimeout(1100);
  const atBalanced = await page.evaluate(() => {
    const viewport = (window as any).__d067.witness().nodeViewport ?? {};
    return Object.fromEntries(Object.entries(viewport).slice(0, 40).map(([id, point]: [string, any]) => [id, {
      x: Math.round(point.x * 256) / 256,
      y: Math.round(point.y * 256) / 256,
    }]));
  });
  await page.evaluate(() => (window as any).__d067.setDensity("essential"));
  await page.waitForTimeout(1100);
  const atEssential = await page.evaluate((ids: string[]) => {
    const viewport = (window as any).__d067.witness().nodeViewport ?? {};
    return Object.fromEntries(ids.map(id => [id, viewport[id] ? {
      x: Math.round((viewport[id] as any).x * 256) / 256,
      y: Math.round((viewport[id] as any).y * 256) / 256,
    } : null]));
  }, Object.keys(atBalanced));
  const staying = Object.keys(atBalanced).filter(id => atEssential[id]);
  expect(staying.length, "the two densities share visible nodes").toBeGreaterThan(0);
  for (const id of staying)
    expect(atEssential[id], `${id} keeps its coordinates across the density change`).toEqual(atBalanced[id]);
});
