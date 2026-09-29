import assert from "node:assert/strict";
import { test } from "node:test";
import { buildContainerGeometry, resetContainerGeometryCache } from "#engine/container-geometry.ts";
import type { MorphologyContainerInput } from "#engine/container-geometry.ts";
import { placeContainerTitles, sphereSegmentCount, sphereSegmentsForQuality } from "#render-common/container-canvas.ts";

test("world-space container geometry is reused for one immutable layout snapshot", () => {
  resetContainerGeometryCache();
  const one: readonly MorphologyContainerInput[] = [
    { id: "sample", level: 1, center: { x: 2, y: 3, z: 4 }, radius: 10, title: "Sample" },
  ];
  const first = buildContainerGeometry("stellar", one);
  assert.strictEqual(buildContainerGeometry("neural", one), first);
  assert.strictEqual(buildContainerGeometry("mycelium", one)[0]?.shell, first[0]?.shell);
  const next: readonly MorphologyContainerInput[] = [{ ...one[0]!, radius: 20 }];
  const changed = buildContainerGeometry("stellar", next);
  assert.notStrictEqual(changed, first);
  assert.equal(changed[0]?.radius, 20);
  resetContainerGeometryCache();
  assert.notStrictEqual(buildContainerGeometry("stellar", one), first);
});

test("moving sphere tier and titles change only the moving drawing", () => {
  for (const radius of [5, 40, 100, 200, 800]) {
    assert.equal(sphereSegmentsForQuality(radius, "full"), sphereSegmentCount(radius));
    assert.equal(sphereSegmentsForQuality(radius, "moving"), 16);
  }
  const containers = buildContainerGeometry("stellar", [
    { id: "sample", level: 1, center: { x: 0, y: 0, z: 0 }, radius: 60, title: "Sample" },
  ]);
  const project = (point: { x: number; y: number; z: number }) => ({ x: 100 + point.x, y: 100 + point.y, scale: 1 });
  const bounds = { width: 300, height: 300 };
  const measure = (value: string) => value.length * 7;
  assert.equal(placeContainerTitles(containers, project, bounds, "3d", { quality: "moving" }, [], measure).length, 0);
  assert.equal(placeContainerTitles(containers, project, bounds, "3d", { quality: "full" }, [], measure).length, 1);
  assert.equal(placeContainerTitles(containers, project, bounds, "2d", { quality: "moving" }, [], measure).length, 1);
});
