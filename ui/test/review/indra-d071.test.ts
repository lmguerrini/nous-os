import assert from "node:assert/strict";
import { test } from "node:test";
import { ABSOLUTE_CONTAINER_ID, DEPTH_RATIO_MIN, computeLayout, layoutStats, pearlRadius } from "../../src/review/layout-v2.ts";
import type { LayoutInput, LayoutNode } from "../../src/review/layout-v2.ts";
import { buildContainerGeometry } from "#engine/morphology-geometry.ts";
import { drawContainers } from "#render-common/container-canvas.ts";
import { indraArcPresentation } from "../../src/review/v2-relations.ts";

const realistic = (): LayoutNode[] => {
  const nodes: LayoutNode[] = Array.from({ length: 8 }, (_, i) => ({ id: `domain:${i}`, level: 1 as const, parent: null, size: 0.7, domains: [] }));
  for (let i = 0; i < 31; i++) nodes.push({ id: `entity:${i}`, level: 2 as const, parent: `domain:${i % 8}`, size: 0.5, domains: [] });
  for (let i = 0; i < 165; i++) nodes.push({ id: `conversation:${i}`, level: 3 as const, parent: `entity:${i % 31}`, size: 0.3, domains: [] });
  for (let i = 0; i < 220; i++) nodes.push({ id: `proposal:${i}`, level: 4 as const, parent: `conversation:${i % 165}`, size: 0.1, domains: [] });
  return nodes;
};

test("Indra 3D nests every child sphere inside its parent with a margin, on a realistic hierarchy", () => {
  const nodes = realistic();
  const input: LayoutInput = { nodes, edges: [], organization: "indra", morphology: "stellar" };
  const result = computeLayout(input);
  assert.deepEqual(result, computeLayout(input));
  assert.ok(layoutStats(result.positions).depthRatio >= DEPTH_RATIO_MIN);
  const containers = new Map(result.containers.map(c => [c.id, c]));
  const byParent = new Map<string, LayoutNode[]>();
  for (const node of nodes) if (node.parent) {
    const list = byParent.get(node.parent) ?? []; list.push(node); byParent.set(node.parent, list);
    const parent = containers.get(node.parent)!;
    const point = result.positions.get(node.id)!;
    const childRadius = containers.get(node.id)?.radius ?? pearlRadius(node);
    // 3D containment with margin.
    assert.ok(Math.hypot(point.x - parent.center.x, point.y - parent.center.y, point.z - parent.center.z) + childRadius <= parent.radius * 0.94 + 1e-9);
  }
  // Sibling spheres never overlap in 3D.
  for (const siblings of byParent.values()) for (let a = 0; a < siblings.length; a++) for (let b = a + 1; b < siblings.length; b++) {
    const left = result.positions.get(siblings[a]!.id)!, right = result.positions.get(siblings[b]!.id)!;
    const leftRadius = containers.get(siblings[a]!.id)?.radius ?? pearlRadius(siblings[a]!), rightRadius = containers.get(siblings[b]!.id)?.radius ?? pearlRadius(siblings[b]!);
    assert.ok(Math.hypot(left.x - right.x, left.y - right.y, left.z - right.z) + 1e-7 >= leftRadius + rightRadius);
  }
  // Every node and its shell lies inside the NousOS sphere.
  const absolute = containers.get(ABSOLUTE_CONTAINER_ID)!;
  for (const ring of result.containers.filter(c => c.level > 0))
    assert.ok(Math.hypot(Math.hypot(ring.center.x, ring.center.y) + ring.radius, ring.center.z - absolute.center.z) <= absolute.radius * 0.94 + 1e-9);
});

test("Indra 3D side view is not parallel planes: z values spread continuously", () => {
  const nodes = realistic();
  const result = computeLayout({ nodes, edges: [], organization: "indra", morphology: "stellar" });
  const zs = nodes.map(n => result.positions.get(n.id)!.z);
  const buckets = new Map<number, number>();
  for (const z of zs) {
    const key = Math.round(z * 1000);
    buckets.set(key, (buckets.get(key) ?? 0) + 1);
  }
  const maximum = Math.max(...buckets.values());
  assert.ok(maximum / nodes.length <= 0.2, `largest single z holds ${maximum} of ${nodes.length} nodes`);
  assert.ok(buckets.size > nodes.length * 0.5, `only ${buckets.size} distinct z values`);
});

test("container geometry gives every container a wireframe shell and never a dashed rim", () => {
  const nodes = realistic();
  const result = computeLayout({ nodes, edges: [], organization: "indra", morphology: "stellar" });
  const paths = buildContainerGeometry("stellar", result.containers);
  assert.equal(paths.length, result.containers.length);
  for (const path of paths) {
    assert.ok(path.shell && path.shell.length >= 3);
    for (const circle of path.shell) assert.ok(circle.length >= 3);
  }
  // drawContainers never requests a dash pattern, in either projection, for open or closed (+N) pearls.
  for (const projection of ["2d", "3d"] as const) {
    const patterns: number[][] = [];
    const context = {
      canvas: { width: 400, height: 400, getBoundingClientRect: () => ({ width: 400, height: 400 }) },
      setTransform() {}, clearRect() {}, setLineDash(p: number[]) { patterns.push(p); },
      beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, fill() {},
      measureText: (t: string) => ({ width: t.length * 6 }),
      fillText() {},
    } as unknown as CanvasRenderingContext2D;
    const closed = paths.map(p => p.id === paths[1]!.id ? { ...p, title: `${p.title ?? 'pearl'} · +12` } : p);
    drawContainers(context, "stellar", closed, point => ({ x: point.x + 200, y: point.y + 200, scale: 1 }), "rgb(0,0,0)", { width: 400, height: 400 }, projection);
    assert.ok(patterns.every(p => p.length === 0), `${projection} produced a dash pattern`);
  }
});

test("Indra non-selected arcs are at most half of the D-070 opacity", () => {
  // D-070: Indra 3D non-exploratory arcs used factor 0.6, Indra 2D used 1.0.
  const flat3d = indraArcPresentation("3d", false);
  const flat2d = indraArcPresentation("2d", false);
  assert.ok(flat3d.opacityFactor <= 0.6 / 2);
  assert.ok(flat2d.opacityFactor <= 1.0 / 2);
  assert.ok(flat3d.widthFactor < 1 && flat2d.widthFactor < 1);
  // Exploratory arcs stay brighter than attested ones but still recede.
  assert.ok(indraArcPresentation("3d", true).opacityFactor > flat3d.opacityFactor);
  assert.ok(indraArcPresentation("2d", true).opacityFactor > flat2d.opacityFactor);
});
