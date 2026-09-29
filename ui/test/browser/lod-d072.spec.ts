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

/** Reach the V2 cap like capture_d072's `reach`: domains first, largest conversations next. */
const disclose = async (page: Page, target = 850) => {
  await page.evaluate(async (limit) => {
    const api = (window as any).__d067;
    const domains = api.disclosure().nodes.filter((node: { level: number }) => node.level === 1);
    for (const domain of domains) {
      if (api.disclosure().visible >= limit) break;
      try { await api.expand(domain.id); } catch { /* capped or already unavailable */ }
    }
    const index = await (await fetch('/api/graph/index')).json();
    const conversations = index.nodes.filter((node: { level: number }) => node.level === 3)
      .sort((a: any, b: any) => (b.counts?.descendants || 0) - (a.counts?.descendants || 0));
    for (const conversation of conversations) {
      const state = api.disclosure();
      if (state.visible >= limit || (state.capped && state.visible >= 850)) break;
      try { await api.reveal(conversation.id); await api.expand(conversation.id); } catch { /* continue to the next candidate */ }
    }
  }, target);
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

/** Zoom in four-notch groups, giving the deferred LOD refresh up to three seconds after each
 * group. The level trace distinguishes a missed refresh from a camera that stopped zooming. */
const zoomUntilNear = async (page: Page, assertion: string) => {
  const trace: string[] = [];
  let level = (await lod(page)).level;
  trace.push(level);
  let notches = 0;
  while (level !== "near" && notches < 40) {
    const groupSize = Math.min(4, 40 - notches);
    for (let i = 0; i < groupSize; i += 1) await notch(page, 1, 0);
    notches += groupSize;

    const previous = level;
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const observed = (await lod(page)).level;
      if (observed !== level) {
        level = observed;
        trace.push(level);
        if (level === "near") break;
      }
      if (level !== previous) break;
      await page.waitForTimeout(50);
    }
  }
  if (level !== "near") {
    const camera = await page.evaluate(() => (window as any).__d067.cameraState());
    const ratio = camera && typeof camera === "object" ? camera.ratio : undefined;
    expect(level, `${assertion}; zoom ratio=${String(ratio)}, level trace=${trace.join(" -> ")}`).toBe("near");
  }
  return { level, trace };
};

/** render-schedule.ts defers level refresh by LOD_REFRESH_IDLE_MS (300 ms), observed on the
 * page's 250 ms zoom tick. Poll after a crossing sequence because one notch's 400 ms settle
 * can finish before both scheduling intervals have elapsed. */
const waitForLevel = async (page: Page, expected: string, timeout = 3000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if ((await lod(page)).level === expected) return;
    await page.waitForTimeout(50);
  }
  throw new Error(`LOD level did not become ${expected} within ${timeout} ms`);
};

test("D-072 each density keeps its node, arc and label budgets", async ({ page }, testInfo) => {
  await ready(page);
  await page.evaluate(() => (window as any).__d067.setAxes({
    projection: "2d", organization: "flat", reading: "attested", morphology: "stellar",
  }));
  await disclose(page);
  await page.mouse.move(1, 1);
  const focused = await page.evaluate(() => (window as any).__d067.witness().focus?.id as string | undefined);
  if (focused) await page.evaluate(id => (window as any).__d067.select(id), focused);
  await page.waitForTimeout(1100);

  // The newest manual expansion contributes at most one page of pinned children.
  const disclosureState = await page.evaluate(() => {
    const state = (window as any).__d067.disclosure();
    return {
      manualOrder: state.manualOrder as string[],
      nodes: state.nodes as Array<{ id: string; parent?: string }>,
      visible: state.visible as number,
    };
  });
  expect(disclosureState.visible, "manual disclosure reaches the cap").toBeGreaterThanOrEqual(800);
  expect(disclosureState.manualOrder.length, "manual expansions were recorded").toBeGreaterThan(1);
  const latest = disclosureState.manualOrder.at(-1)!;
  const latestChildren = disclosureState.nodes.filter(node => node.parent === latest).map(node => node.id);
  const allowedPinned = new Set<string>([...disclosureState.manualOrder, ...latestChildren]);

  const results: Record<string, LodWitness & { panel: string }> = {};
  const order = ["essential", "balanced", "complete", "balanced"] as const;
  for (const density of order) {
    await page.evaluate((value) => (window as any).__d067.setDensity(value), density);
    await page.waitForTimeout(1100);
    const witness = await lod(page);
    const budget = BUDGETS[density as keyof typeof BUDGETS];
    expect(witness.density, `density setting took effect`).toBe(density);
    if (density !== 'complete')
      expect(witness.nodes.available, `${density}: disclosed set binds the node budget`).toBeGreaterThan(budget.nodes);
    expect(witness.nodes.pinned, `${density}: explicit pins are bounded`)
      .toBeLessThanOrEqual(60 + disclosureState.manualOrder.length);
    expect(witness.nodes.rendered, `${density}: nodes ≤ ${budget.nodes} + pinned`).toBeLessThanOrEqual(budget.nodes + witness.nodes.pinned);
    if (density === 'complete')
      expect(witness.nodes.rendered, 'complete: every available node fits within its 850 node budget')
        .toBeGreaterThanOrEqual(Math.min(witness.nodes.available, budget.nodes));
    for (const id of witness.nodes.pinnedIds)
      expect(allowedPinned.has(id), `${density}: pinned ${id} is a manual container or newest child`).toBe(true);
    const drawn = new Set(await renderedIds(page));
    for (const id of latestChildren)
      expect(drawn.has(id), `${density}: newest child ${id} is visible`).toBe(true);
    expect(witness.arcs.rendered, `${density}: arcs ≤ ${budget.arcs} + pinned`).toBeLessThanOrEqual(budget.arcs + witness.arcs.pinned);
    if (density !== "complete")
      expect(witness.arcs.available, `${density}: disclosed arcs bind the arc budget`).toBeGreaterThan(budget.arcs);
    expect(witness.arcs.pinned, `${density}: forced arcs are counted`).toBe(witness.arcs.pinnedIds.length);
    const allowedArcs = new Set(latestChildren.map(id => `contains:${id}`));
    for (const id of witness.arcs.pinnedIds)
      expect(allowedArcs.has(id), `${density}: pinned arc ${id} contains a newest child`).toBe(true);
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

  // The same unpinned available set binds both smaller budgets, so rendering follows density.
  expect(results.essential!.nodes.available, "essential has more available nodes than its budget")
    .toBeGreaterThan(BUDGETS.essential.nodes);
  expect(results.balanced!.nodes.available, "balanced has more available nodes than its budget")
    .toBeGreaterThan(BUDGETS.balanced.nodes);
  expect(results.essential!.nodes.rendered, "essenziale renders fewer nodes than bilanciata")
    .toBeLessThan(results.balanced!.nodes.rendered);
  expect(results.balanced!.nodes.rendered, "bilanciata renders fewer nodes than completa")
    .toBeLessThan(results.complete!.nodes.rendered);

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
  await waitForLevel(page, 'far');
  const initial = await lod(page);
  await zoomUntilNear(page, "semantic zoom alone reaches the near level");
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

test("D-072 manual expansion pins are included in node budget accounting", async ({ page }) => {
  await ready(page);
  await page.evaluate(() => (window as any).__d067.setAxes({
    projection: "2d", organization: "flat", reading: "attested", morphology: "stellar",
  }));
  const candidate = await page.evaluate(() => {
    const api = (window as any).__d067;
    return api.disclosure().nodes.find((node: { level: number }) => node.level === 1)?.id;
  });
  expect(candidate, "a top-level node is available to expand").toBeTruthy();
  await page.evaluate(async id => (window as any).__d067.expand(id), candidate);
  const second = await page.evaluate(() => {
    const api = (window as any).__d067;
    return api.disclosure().nodes.find((node: { level: number }) => node.level === 2)?.id;
  });
  expect(second, "a child node is available for a second manual expansion").toBeTruthy();
  await page.evaluate(async id => (window as any).__d067.expand(id), second);
  await page.waitForTimeout(1100);

  const state = await page.evaluate(() => (window as any).__d067.disclosure());
  const expanded = new Set<string>(state.manualOrder);
  const justified = new Set<string>(expanded);
  const latest = state.manualOrder.at(-1);
  for (const node of state.nodes)
    if (node.parent === latest) justified.add(node.id);
  await page.evaluate(() => (window as any).__d067.setDensity("essential"));
  await page.waitForTimeout(1100);
  const witness = await lod(page);
  expect(witness.nodes.pinned, "manual expansion contributes accounted pins").toBeGreaterThan(0);
  expect(witness.nodes.rendered, "manual pins are added to the node budget")
    .toBeLessThanOrEqual(BUDGETS.essential.nodes + witness.nodes.pinned);
  for (const id of witness.nodes.pinnedIds)
    expect(justified.has(id), `pinned ${id} is a manual container or newest child`).toBe(true);
});

test("D-072 zoom levels have hysteresis: a notch of jitter changes nothing, crossing a band does", async ({ page }, testInfo) => {
  await ready(page);
  await page.evaluate(() => (window as any).__d067.setAxes({
    projection: "2d", organization: "flat", reading: "attested", morphology: "stellar",
  }));
  await page.evaluate(() => (window as any).__d067.fit());
  await waitForLevel(page, 'far');

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
  await waitForLevel(page, 'far');
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
