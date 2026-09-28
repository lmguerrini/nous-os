import { expect, test, type Page } from "@playwright/test";
import { writeFile } from "node:fs/promises";

const url = process.env.D071_URL ?? "http://127.0.0.1:8768/";
test.skip(process.env.D071_BROWSER !== "1", "Set D071_BROWSER=1 and serve the review page");

type Pose = { position: number[]; target: number[]; up: number[]; fov: number };
type CellMeasure = {
  nodes: number;
  outside: string[];
  targetInside: boolean | null;
  fov: number | null;
  labels: number;
  target: number[] | null;
};

/**
 * The D-071 defect sequence per cell: frame the base view, apply the orientation, switch the
 * morphology (which remounts and restores the saved camera over new bounds), then fit again.
 * `iso` is the default oblique opening, reached the way the page reaches it: the reset view.
 */
type Cell =
  | { readonly morphology: "stellar" | "neural" | "mycelium"; readonly kind: "preset"; readonly preset: "fronte" | "sinistra" | "alto" | "iso" }
  | { readonly morphology: "stellar" | "neural" | "mycelium"; readonly kind: "flat2d" }
  | { readonly morphology: "stellar" | "neural" | "mycelium"; readonly kind: "indra" };

const CELLS: readonly Cell[] = (["stellar", "neural", "mycelium"] as const).flatMap((morphology) => [
  ...(["fronte", "sinistra", "alto", "iso"] as const).map((preset) => ({ morphology, kind: "preset", preset }) as Cell),
  { morphology, kind: "flat2d" } as Cell,
  { morphology, kind: "indra" } as Cell,
]);

const cellName = (cell: Cell) => cell.kind === "preset" ? `${cell.morphology}/3d-flat/${cell.preset}` : `${cell.morphology}/${cell.kind === "flat2d" ? "flat-2d" : "indra-3d"}`;

const ready = async (page: Page) => {
  await page.goto(url);
  await page.evaluate(() => (window as any).__d067.ready);
  await expect(page.locator("#status")).toContainText("Grafo pronto");
};

/** Two consecutive frames with an unchanged camera (or, in 2D, unchanged node positions); bounded. */
const settled = (page: Page) => page.evaluate(() => new Promise<boolean>((resolve) => {
  const api = (window as any).__d067;
  const round = (_key: string, value: unknown) => typeof value === "number" ? Math.round(value * 100) / 100 : value;
  const signature = () => {
    try {
      const pose = api.camera();
      if (pose) return JSON.stringify(["pose", pose.position, pose.target, pose.up, pose.fov], round);
      return JSON.stringify(["nodes", api.witness().nodeViewport], round);
    } catch {
      return "unready";
    }
  };
  let previous = signature();
  let stable = 0;
  let frames = 0;
  const tick = () => {
    frames += 1;
    const current = signature();
    stable = current === previous ? stable + 1 : 0;
    previous = current;
    if (stable >= 2 || frames > 300) resolve(stable >= 2);
    else requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}));

const measure = (page: Page) => page.evaluate(() => {
  const api = (window as any).__d067;
  const witness = api.witness();
  const rect = witness.visibleRect as { left: number; top: number; width: number; height: number };
  const nodes = Object.entries(witness.nodeViewport) as [string, { x: number; y: number }][];
  const outside = nodes.filter(([, p]) =>
    !(p.x >= rect.left - 1 && p.x <= rect.left + rect.width + 1 && p.y >= rect.top - 1 && p.y <= rect.top + rect.height + 1))
    .map(([id]) => id);
  const pose = api.camera() as Pose | null;
  const positions = Object.values(witness.positions) as { x: number; y: number; z: number }[];
  // The node bounding box expanded by half its own size, axis by axis.
  const expanded = (axis: "x" | "y" | "z") => {
    const values = positions.map((p) => p[axis]);
    const min = Math.min(...values), max = Math.max(...values);
    const half = Math.max(max - min, 1e-9) / 2;
    return [min - half, max + half] as const;
  };
  const targetInside = pose && positions.length
    ? (["x", "y", "z"] as const).every((axis, index) =>
      pose.target[index]! >= expanded(axis)[0] && pose.target[index]! <= expanded(axis)[1])
    : null;
  return {
    nodes: nodes.length,
    outside,
    targetInside,
    fov: pose ? pose.fov : null,
    labels: (witness.labels as unknown[]).length,
    target: pose ? pose.target : null,
  } satisfies CellMeasure;
});

test("D-071 fit after an orientation and a morphology switch keeps every camera framed", async ({ page }, testInfo) => {
  await ready(page);
  const results: Record<string, CellMeasure> = {};
  for (const cell of CELLS) {
    await page.evaluate((kind) => (window as any).__d067.setAxes(kind === "flat2d"
      ? { projection: "2d", organization: "flat", reading: "attested", morphology: "stellar" }
      : kind === "indra"
        ? { projection: "3d", organization: "indra", reading: "attested", morphology: "stellar" }
        : { projection: "3d", organization: "flat", reading: "attested", morphology: "stellar" }), cell.kind);
    await page.evaluate(() => (window as any).__d067.fit());
    if (cell.kind === "preset") {
      // `iso` has no button of its own: the page's reset restores the default oblique opening.
      await page.evaluate((preset) => (window as any).__d067.viewPreset(preset === "iso" ? "reset" : preset), cell.preset);
    }
    await page.evaluate((morphology) => (window as any).__d067.setAxes({ morphology }), cell.morphology);
    await page.evaluate(() => (window as any).__d067.fit());
    await expect.poll(() => settled(page), { timeout: 20000, message: `${cellName(cell)}: camera never settled` }).toBe(true);
    results[cellName(cell)] = await measure(page);
  }
  await writeFile(testInfo.outputPath("fit-cells.json"), JSON.stringify(results, null, 2));
  for (const [name, result] of Object.entries(results)) {
    expect(result.nodes, `${name}: visible nodes`).toBeGreaterThan(0);
    expect(result.outside, `${name}: every visible node stays inside the viewport`).toEqual([]);
    if (result.fov !== null) {
      expect(result.targetInside, `${name}: camera target inside the node box expanded by half its size`).toBe(true);
      expect(result.fov, `${name}: fov stays between 10° and 90°`).toBeGreaterThanOrEqual(10);
      expect(result.fov, `${name}: fov stays between 10° and 90°`).toBeLessThanOrEqual(90);
    }
    expect(result.labels, `${name}: at least one label is shown`).toBeGreaterThan(0);
  }
  console.log(`D-071 fit cells: ${Object.entries(results).map(([name, r]) =>
    `${name} nodes=${r.nodes} outside=${r.outside.length} fov=${r.fov === null ? "-" : r.fov.toFixed(1)} labels=${r.labels}`).join(" | ")}`);
});
