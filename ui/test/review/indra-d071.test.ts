import assert from "node:assert/strict";
import { test } from "node:test";
import { ABSOLUTE_CONTAINER_ID, DEPTH_RATIO_MIN, computeLayout, layoutStats, pearlRadius } from "../../src/review/layout-v2.ts";
import type { LayoutInput, LayoutNode } from "../../src/review/layout-v2.ts";
import { buildContainerGeometry } from "#engine/morphology-geometry.ts";
import {
  CONTAINER_SPHERE_MIN_PX,
  GREAT_CIRCLE_FLATNESS_CUTOFF,
  GREAT_CIRCLE_FLATNESS_FULL,
  chosenEquator,
  containerSphereLOD,
  containerTitleRect,
  drawContainers,
  greatCircleFade,
  projectedFlatness,
  projectedWorldScale,
} from "#render-common/container-canvas.ts";
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
      beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, fill() {}, arc() {}, closePath() {},
      createRadialGradient: () => ({ addColorStop() {} }),
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

test("projected flatness reads 1 face-on, 0 edge-on, and the fade cuts below the cutoff", () => {
  const circle = (points: { x: number; y: number }[]) => points;
  const xy = circle(Array.from({ length: 65 }, (_, i) => {
    const t = (i / 64) * Math.PI * 2;
    return { x: Math.cos(t) * 100, y: Math.sin(t) * 100 };
  }));
  // Face-on (orthographic front view of the xy plane): a full circle. (The 65-point sampling with its
  // duplicated endpoint biases the sample covariance a little below 1.)
  assert.ok(projectedFlatness(xy) > 0.97, `face-on flatness ${projectedFlatness(xy)}`);
  // Edge-on: the same circle projected side-on collapses to a horizontal line.
  const edgeOn = xy.map(point => ({ x: point.x, y: 0 }));
  assert.equal(projectedFlatness(edgeOn), 0);
  // A 45° tilt gives the sine of the tilt.
  const tilted = xy.map(point => ({ x: point.x, y: point.y * Math.SQRT1_2 }));
  assert.ok(Math.abs(projectedFlatness(tilted) - Math.SQRT1_2) < 0.02);
  // The fade: nothing at or below the cutoff, full above the full point, linear between.
  assert.equal(greatCircleFade(GREAT_CIRCLE_FLATNESS_CUTOFF), 0);
  assert.equal(greatCircleFade(0), 0);
  assert.equal(greatCircleFade(GREAT_CIRCLE_FLATNESS_FULL), 1);
  assert.equal(greatCircleFade(1), 1);
  const mid = (GREAT_CIRCLE_FLATNESS_CUTOFF + GREAT_CIRCLE_FLATNESS_FULL) / 2;
  assert.ok(Math.abs(greatCircleFade(mid) - 0.5) < 1e-9);
});

test("a sphere draws at most one equator: the most face-on circle, never an edge-on one", () => {
  const paths = buildContainerGeometry("stellar", [
    { id: "sphere", level: 1, center: { x: 0, y: 0, z: 0 }, radius: 50 },
  ])[0]!;
  const shell = paths.shell!;
  assert.equal(shell.length, 3);
  // Front view (drop z): the equator parallel to the screen (z = 0) is chosen, at full fade.
  const front = chosenEquator(shell, point => ({ x: point.x, y: point.y, scale: 1 }))!;
  assert.ok(front.circle.every(point => point.z === 0), "front view must choose the xy circle");
  assert.ok(front.fade > 0.99);
  // Exactly one circle comes back, never a set.
  assert.equal(front.circle.length, 65);
  // A single circle seen edge-on is not drawn at all: no long meaningless line.
  const meridian = shell.find(circle => circle.some(p => p.y === 0 && Math.abs(p.z) > 1))!;
  assert.ok(meridian.every(point => point.y === 0));
  assert.equal(chosenEquator([meridian], point => ({ x: point.x, y: point.y, scale: 1 })), null);
  // Any camera: one orthogonal triad always offers a circle above the cutoff, so a sphere keeps an equator.
  const tilted = chosenEquator(shell, point => ({ x: point.x + point.z * 0.3, y: point.y + point.z * 0.2, scale: 1 }))!;
  assert.ok(tilted.flatness >= GREAT_CIRCLE_FLATNESS_CUTOFF);
  assert.ok(greatCircleFade(tilted.flatness) > 0);
});

test("container sphere LOD: NousOS and domains always, inner spheres only open, selected or large", () => {
  assert.equal(containerSphereLOD(0, false, false, 0), true);
  assert.equal(containerSphereLOD(1, false, false, 1), true);
  assert.equal(containerSphereLOD(2, false, false, CONTAINER_SPHERE_MIN_PX - 0.1), false);
  assert.equal(containerSphereLOD(2, false, false, CONTAINER_SPHERE_MIN_PX), true);
  assert.equal(containerSphereLOD(3, true, false, 1), true, "an open sphere always draws");
  assert.equal(containerSphereLOD(3, false, true, 1), true, "a selected sphere always draws");
  assert.equal(containerSphereLOD(4, false, false, 200), true);
});

test("projectedWorldScale measures true px-per-world-unit, not the depth scale", () => {
  const orthographic = (point: { x: number; y: number; z: number }) => ({ x: point.x * 0.2, y: point.y * 0.2 });
  assert.ok(Math.abs(projectedWorldScale({ x: 0, y: 0, z: 0 }, 100, orthographic) - 0.2) < 1e-9);
  // An axis pointing at the camera projects to nothing; the two screen axes still give the scale.
  const perspectiveLike = (point: { x: number; y: number; z: number }) => ({ x: point.x * 0.3, y: point.y * 0.5 });
  assert.ok(Math.abs(projectedWorldScale({ x: 0, y: 0, z: 0 }, 100, perspectiveLike) - 0.4) < 1e-9);
});

function recordingContext(arcs: { x: number; y: number; r: number }[], verts: { x: number; y: number }[] = []) {
  return {
    canvas: { width: 900, height: 640, getBoundingClientRect: () => ({ width: 900, height: 640 }) },
    setTransform() {}, clearRect() {}, setLineDash() {}, beginPath() {}, closePath() {},
    moveTo(x: number, y: number) { verts.push({ x, y }); }, lineTo(x: number, y: number) { verts.push({ x, y }); },
    stroke() {}, fill() {}, fillText() {}, measureText: (text: string) => ({ width: text.length * 6 }),
    arc(x: number, y: number, r: number) { arcs.push({ x, y, r }); },
    createRadialGradient: () => ({ addColorStop() {} }),
  } as unknown as CanvasRenderingContext2D;
}

test("3D limbs draw at true projected size; small closed spheres draw none and keep their pearl title", () => {
  const containers = buildContainerGeometry("stellar", [
    { id: "nousos", level: 0, center: { x: 0, y: 0, z: 0 }, radius: 1000, open: true, title: "NousOS" },
    { id: "domain", level: 1, center: { x: -300, y: 0, z: 0 }, radius: 400, open: true },
    { id: "project", level: 2, center: { x: 300, y: 0, z: 0 }, radius: 60, open: false, title: "project · +12" },
    { id: "conversation", level: 3, center: { x: 0, y: 280, z: 0 }, radius: 70, open: true },
  ]);
  // An overview projector: 0.2 px per world unit, front view.
  const project = (point: { x: number; y: number; z: number }) => ({ x: 450 + point.x * 0.2, y: 320 + point.y * 0.2, scale: 1 });
  const arcs: { x: number; y: number; r: number }[] = [];
  const verts: { x: number; y: number }[] = [];
  const hook: Record<string, number | undefined> = { dashed: 0, draws: 0 };
  (globalThis as typeof globalThis & { __indraContainers?: unknown }).__indraContainers = hook;
  try {
    drawContainers(recordingContext(arcs, verts), "stellar", containers, project, "rgb(0,0,0)", { width: 900, height: 640 }, "3d");
  } finally {
    delete (globalThis as typeof globalThis & { __indraContainers?: unknown }).__indraContainers;
  }
  const near = (x: number, y: number) => arcs.filter(arc => Math.hypot(arc.x - x, arc.y - y) < 2);
  // The NousOS limb is its true projected radius (~200 px), never its world radius drawn as pixels:
  // the limb is a polyline from the unit-circle table, so its vertices sit on that circle.
  const distances = verts.map(vertex => Math.hypot(vertex.x - 450, vertex.y - 320));
  assert.ok(distances.filter(distance => Math.abs(distance - 200) < 5).length >= 60, `nousos limb vertices: ${distances.filter(d => Math.abs(d - 200) < 5).length}`);
  assert.ok(Math.max(...distances, 0) < 260, "a limb drew at world units mistaken for pixels");
  assert.ok(Math.max(...arcs.map(arc => arc.r)) < 260, "a fill disc drew at world units mistaken for pixels");
  // A domain sphere draws; a small open conversation sphere still draws (children visible).
  assert.ok(near(390, 320).length > 0);
  assert.ok(near(450, 376).length > 0);
  // The closed project sphere is 12 px on screen: below the LOD, no limb and no fill at all.
  assert.equal(near(510, 320).length, 0);
  // Exactly the three LOD-visible spheres stroked a limb, each with one equator, all above the cutoff.
  assert.equal(hook.limbs, 3);
  assert.equal(hook.equators, 3);
  assert.ok((hook.minEquatorFlatness ?? 0) >= GREAT_CIRCLE_FLATNESS_CUTOFF);
  assert.equal(hook.dashed, 0);
  // The closed pearl keeps its name: anchored above the pearl itself (its projected radius plus a
  // gap), even though the sphere is narrow.
  const pearl = containers.find(container => container.id === "project")!;
  const rect = containerTitleRect(pearl, project, { width: 900, height: 640 }, "3d");
  assert.ok(rect, "a closed pearl below the LOD keeps its «+N» title");
  assert.ok(Math.abs(rect.top - (320 - 12 - 12 - 18)) < 1e-9, `title top ${rect.top}`);
  assert.ok(Math.abs(rect.left + rect.width / 2 - 510) < 1e-9);
  // When the sphere is selected the LOD lifts and the title follows the sphere rim again.
  const focused = containerTitleRect(pearl, project, { width: 900, height: 640 }, "3d", { focusIds: new Set(["project"]) });
  assert.equal(focused, null, "a 24 px sphere is too narrow for a rim title");
  // 2D keeps the previous rule: a narrow ring carries no canvas title.
  assert.equal(containerTitleRect(pearl, point => ({ x: point.x, y: point.y }), { width: 900, height: 640 }, "2d"), null);
});

test("the layout marks open containers (children visible) against closed +N pearls", () => {
  const nodes: LayoutNode[] = [
    { id: "domain:a", level: 1, parent: null, size: 0.6, domains: [] },
    { id: "domain:b", level: 1, parent: null, size: 0.6, domains: [] },
    { id: "project:open", level: 2, parent: "domain:a", size: 0.4, domains: [] },
    { id: "convo:1", level: 3, parent: "project:open", size: 0.2, domains: [] },
    { id: "convo:2", level: 3, parent: "project:open", size: 0.2, domains: [] },
    { id: "project:closed", level: 2, parent: "domain:b", size: 0.4, domains: [], hiddenDescendants: 12 },
  ];
  const result = computeLayout({ nodes, edges: [], organization: "indra", morphology: "stellar" });
  const byId = new Map(result.containers.map(container => [container.id, container]));
  assert.equal(byId.get(ABSOLUTE_CONTAINER_ID)!.open, true);
  assert.equal(byId.get("domain:a")!.open, true);
  assert.equal(byId.get("project:open")!.open, true);
  assert.equal(byId.get("project:closed")!.open, false);
});
