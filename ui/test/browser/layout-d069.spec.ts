import { expect, test } from "@playwright/test";
import { writeFile } from "node:fs/promises";

test.skip(process.env.D069_CAPTURE !== "1", "Set D069_CAPTURE=1 and serve the review page");

for (const projection of ["2d", "3d"] as const) for (const organization of ["flat", "indra"] as const) {
  test(`D-069 layout ${organization} ${projection} in three morphologies`, async ({ page }, testInfo) => {
    await page.goto(process.env.D069_URL ?? "http://127.0.0.1:8768/");
    await page.waitForFunction(() => Boolean((window as any).__d067));
    await page.evaluate(() => (window as any).__d067.ready);
    for (const morphology of ["stellar", "neural", "mycelium"] as const) {
      await page.evaluate(async axes => { await (window as any).__d067.setAxes(axes); },
        { projection, organization, morphology, colour: "bw", labels: false });
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      await expect(page.locator("#viewport canvas[data-morphology-canvas]")).toBeVisible();
      await writeFile(testInfo.outputPath(`${organization}-${projection}-${morphology}.png`), await page.locator("#viewport").screenshot());
      const hierarchy = await page.evaluate(() => {
        const witness = (window as any).__d067.witness();
        const containers = witness.containers ?? witness.layoutContainers ?? witness.layout?.containers ?? [];
        const source = witness.layoutSource ?? witness.layout?.source ?? witness.source;
        const nested = containers.some((outer: any) => containers.some((inner: any) => {
          if (outer.id === inner.id || outer.level >= inner.level) return false;
          const distance = Math.hypot(outer.center.x - inner.center.x, outer.center.y - inner.center.y);
          return distance + inner.radius <= outer.radius + 1e-6;
        }));
        return { count: containers.length, nested, source };
      });
      if (organization === "indra") {
        expect(hierarchy.count).toBeGreaterThan(0);
        expect(hierarchy.nested).toBe(true);
        expect(hierarchy.source).toBe("indra-recursive");
      } else {
        expect(hierarchy.count).toBe(0);
        expect(hierarchy.source).toBe("flat-community");
      }
    }
  });
}
