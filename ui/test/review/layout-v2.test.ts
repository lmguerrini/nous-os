import assert from "node:assert/strict";
import { test } from "node:test";
import { performance } from "node:perf_hooks";
import { computeLayout, type LayoutInput, type LayoutNode, type Point3 } from "../../src/review/layout-v2.ts";
import { buildContainerGeometry, buildMorphologyGeometry } from "#engine/morphology-geometry.ts";
import { drawMorphologyCanvas } from "#render-common/morphology-canvas.ts";

function fixture(count = 2500): LayoutInput {
  const nodes: LayoutNode[] = [];
  for (let i = 0; i < count; i++) {
    const level = i < 5 ? 1 : i < 30 ? 2 : i < 280 ? 3 : 4;
    const parent = level === 1 ? null : level === 2 ? `n${Math.floor((i - 5) / 5)}`
      : level === 3 ? `n${5 + Math.floor((i - 30) / 10)}` : `n${30 + Math.floor((i - 280) / 9)}`;
    nodes.push({ id: `n${i}`, level, parent, size: (i % 11) / 10, domains: [] });
  }
  const edges = nodes.filter(node => node.parent).map(node => ({ id: `e${node.id}`, source: node.parent!, target: node.id, class: "attested" as const }));
  return { nodes, edges, organization: "flat", morphology: "stellar" };
}
const xy = (a: Point3, b: Point3) => Math.hypot(a.x - b.x, a.y - b.y);

test("layout determinism, incremental stability, depth and morphology membership", () => {
  const input = fixture(350);
  for (const organization of ["flat", "indra"] as const) {
    const first = computeLayout({ ...input, organization });
    const second = computeLayout({ ...input, organization });
    assert.deepEqual(first, second);
    assert.equal(first.positions.size, input.nodes.length);
    assert.ok([...first.positions.values()].some(point => point.z !== 0));
    const neural = computeLayout({ ...input, organization, morphology: "neural" });
    const mycelium = computeLayout({ ...input, organization, morphology: "mycelium" });
    assert.deepEqual(first.containers.map(c => c.id), neural.containers.map(c => c.id));
    assert.deepEqual(first.containers.map(c => c.id), mycelium.containers.map(c => c.id));
    assert.notDeepEqual(first.positions.get("n10"), neural.positions.get("n10"));
    if (organization === "flat") {
      const prefix = fixture(280);
      const previous = computeLayout(prefix);
      const increment = computeLayout({ ...input, previous: previous.positions });
      for (const [id, position] of previous.positions) assert.deepEqual(increment.positions.get(id), position);
      const points = [...increment.positions];
      for (let a = 0; a < points.length; a++) for (let b = a + 1; b < points.length; b++)
        assert.ok(xy(points[a]![1], points[b]![1]) > 20);
    }
  }
});

test("Indra packs visible children inside their parents without sibling overlap", () => {
  const base = fixture(500);
  const input = { ...base, nodes: [...base.nodes,
    { id: "passage", level: 5 as const, parent: "n280", size: 0.4, domains: [] },
    { id: "skipped-project", level: 3 as const, parent: "n0", size: 0.5, domains: [] }] };
  const result = computeLayout({ ...input, organization: "indra" });
  const containers = new Map(result.containers.map(c => [c.id, c]));
  const byParent = new Map<string, LayoutNode[]>();
  for (const node of input.nodes) if (node.parent) {
    const list = byParent.get(node.parent) ?? []; list.push(node); byParent.set(node.parent, list);
    const parent = containers.get(node.parent);
    assert.ok(parent);
    const point = result.positions.get(node.id)!;
    const childRadius = containers.get(node.id)?.radius ?? 0;
    // containment is read in the front view: every level's ring lies in its own tier plane
    assert.ok(Math.hypot(point.x - parent.center.x, point.y - parent.center.y) + childRadius < parent.radius);
  }
  for (const siblings of byParent.values()) for (let a = 0; a < siblings.length; a++) for (let b = a + 1; b < siblings.length; b++) {
    const left = containers.get(siblings[a]!.id), right = containers.get(siblings[b]!.id);
    if (left && right) assert.ok(xy(left.center, right.center) > left.radius + right.radius);
  }
  assert.deepEqual([...new Set(result.containers.map(c => c.level))].sort(), [1, 2, 3, 4]);
});

test("Flat leaves a size-scaled separation and bounded neighbourhood depth", () => {
  const input = fixture(500);
  const result = computeLayout(input);
  assert.equal(result.source, "flat-community");
  assert.equal(result.containers.length, 0);
  for (let a = 0; a < input.nodes.length; a++) for (let b = a + 1; b < input.nodes.length; b++) {
    const left = input.nodes[a]!, right = input.nodes[b]!;
    const minimum = (21 * 1.45 / Math.sqrt(0.55)) * (0.72 + (10 + Math.min(1, left.size) * 5 + Math.min(1, right.size) * 5) / 24);
    assert.ok(xy(result.positions.get(left.id)!, result.positions.get(right.id)!) + 1e-9 >= minimum);
  }
  const extent = Math.max(...[...result.positions.values()].map(p => p.z)) - Math.min(...[...result.positions.values()].map(p => p.z));
  assert.ok(extent > 30 && extent < 150);
  for (const edge of input.edges) assert.ok(Math.abs(result.positions.get(edge.source)!.z - result.positions.get(edge.target)!.z) < 150);
});

test("container paths appear in both projections, and Stellar geometry remains straight", () => {
  const input = fixture(80);
  const result = computeLayout({ ...input, organization: "indra" });
  const paths = buildContainerGeometry("mycelium", result.containers);
  assert.equal(paths.length, result.containers.length);
  assert.ok(paths.every(path => path.points.length === 65));
  const projectFront = (p: Point3) => ({ x: p.x, y: p.y });
  const projectRotated = (p: Point3) => ({ x: p.x + p.z * 0.4, y: p.y + p.z * 0.2 });
  assert.ok(paths[0]!.points.map(projectFront).some(p => Number.isFinite(p.x)));
  assert.ok(paths[0]!.points.map(projectRotated).some(p => Number.isFinite(p.y)));
  const geometry = buildMorphologyGeometry("stellar", [
    { id: "a", position: { x: 0, y: 0, z: 0 }, radius: 2 },
    { id: "b", position: { x: 5, y: 2, z: 3 }, radius: 2 },
  ], [{ id: "edge", source: "a", target: "b", width: 1 }]);
  assert.equal(geometry.drawnSegments[0]!.samples.length, 2);
  assert.equal(geometry.drawnSegments[0]!.curvature, 0);
});

test("2500 visible nodes stay within layout budgets", () => {
  const base = fixture();
  const input = { ...base, edges: Array.from({ length: 120 }, (_, index) => ({ id: `relation${index}`,
    source: `n${280 + index * 17 % 2220}`, target: `n${280 + (index * 97 + 41) % 2220}`,
    class: "attested" as const })) };
  for (const [organization, budget] of [["flat", 300], ["indra", 100]] as const) {
    const start = performance.now();
    const result = computeLayout({ ...input, organization });
    const elapsed = performance.now() - start;
    assert.equal(result.positions.size, 2500);
    assert.ok(elapsed <= budget, `${organization}: ${elapsed.toFixed(1)} ms exceeds ${budget} ms`);
  }
});


test("Flat forms organic communities distinct from recursive Indra", () => {
  const input = fixture(350);
  const flat = computeLayout(input);
  const indra = computeLayout({ ...input, organization: "indra" });
  assert.equal(flat.containers.length, 0);
  assert.ok(indra.containers.length > 0);
  const displacements = input.nodes.map(node => xy(flat.positions.get(node.id)!, indra.positions.get(node.id)!));
  assert.ok(displacements.filter(distance => distance > 100).length > input.nodes.length * 0.75);
  const points = [...flat.positions.values()];
  for (let a = 0; a < points.length; a++) for (let b = a + 1; b < points.length; b++)
    assert.ok(xy(points[a]!, points[b]!) > 20);
  const deltas = input.nodes.filter(node => node.parent === "n5").map(node => {
    const point = flat.positions.get(node.id)!;
    return Math.round(Math.atan2(point.y - flat.positions.get("n5")!.y, point.x - flat.positions.get("n5")!.x) * 100);
  });
  assert.ok(new Set(deltas).size > 5);
});

test("distinct canvas strokes container outlines in both projected views", () => {
  const container = buildContainerGeometry("stellar", [{ id: "sample", level: 1, center: { x: 0, y: 0, z: 0 }, radius: 20 }]);
  const geometry = buildMorphologyGeometry("stellar", [], []);
  for (const projection of ["2d", "3d"] as const) {
    let strokes = 0;
    const context = {
      canvas: { width: 200, height: 200, getBoundingClientRect: () => ({ width: 200, height: 200 }) },
      setTransform() {}, clearRect() {}, setLineDash() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() { strokes++; },
    } as unknown as CanvasRenderingContext2D;
    drawMorphologyCanvas(context, geometry, point => ({ x: point.x + 100 + (projection === "3d" ? point.z * 0.4 : 0), y: point.y + 100 + (projection === "3d" ? point.z * 0.2 : 0), scale: 1 }),
      { fieldColor: "rgb(0, 0, 0)", nodes: new Map(), edges: new Map() }, undefined, container, projection);
    assert.equal(strokes, projection === "3d" ? 2 : 1);
  }
});

test('2500 independent roots avoid quadratic force work', () => {
  const nodes: LayoutNode[] = Array.from({ length: 2500 }, (_, index) => ({
    id: `root:${index}`, level: 1, parent: null, size: 0.2, domains: [],
  }));
  const start = performance.now();
  const result = computeLayout({ nodes, edges: [], organization: 'flat', morphology: 'stellar' });
  assert.equal(result.positions.size, nodes.length);
  assert.ok(performance.now() - start <= 300);
});
