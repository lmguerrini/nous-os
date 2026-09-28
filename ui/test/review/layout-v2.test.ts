import assert from "node:assert/strict";
import { test } from "node:test";
import { performance } from "node:perf_hooks";
import { ABSOLUTE_CONTAINER_ID, DEPTH_RATIO_MIN, computeLayout, layoutStats, packDiscs, pearlRadius, type LayoutEdge, type LayoutInput, type LayoutNode, type Point3 } from "../../src/review/layout-v2.ts";
import { applyExpansion, equilibrate, volumeStats } from "../../src/review/volume.ts";
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
    if (organization === "indra") assert.ok([...first.positions.values()].some(point => point.z !== 0));
    const neural = computeLayout({ ...input, organization, morphology: "neural" });
    const mycelium = computeLayout({ ...input, organization, morphology: "mycelium" });
    assert.deepEqual(first.containers.map(c => c.id), neural.containers.map(c => c.id));
    assert.deepEqual(first.containers.map(c => c.id), mycelium.containers.map(c => c.id));
    if (organization === "indra") {
      assert.deepEqual(first.positions, neural.positions);
      assert.deepEqual(first.positions, mycelium.positions);
      assert.deepEqual(first.containers, neural.containers);
      assert.deepEqual(first.containers, mycelium.containers);
    } else assert.notDeepEqual(first.positions.get("n10"), neural.positions.get("n10"));
    if (organization === "flat") {
      const prefix = fixture(280);
      const previous = computeLayout(prefix);
      const increment = computeLayout({ ...input, previous: previous.positions });
      for (const [id, position] of previous.positions) {
        assert.equal(increment.positions.get(id)?.x, position.x);
        assert.equal(increment.positions.get(id)?.y, position.y);
      }
      const points = [...increment.positions];
      for (let a = 0; a < points.length; a++) for (let b = a + 1; b < points.length; b++)
        assert.ok(xy(points[a]![1], points[b]![1]) > 20);
    }
  }
});

test("Indra packs visible children inside their parents without sibling overlap in every morphology", () => {
  const base = fixture(500);
  const input = { ...base, nodes: [...base.nodes,
    { id: "passage", level: 5 as const, parent: "n280", size: 0.4, domains: [] },
    { id: "skipped-project", level: 3 as const, parent: "n0", size: 0.5, domains: [] }] };
  for (const morphology of ["stellar", "neural", "mycelium"] as const) {
  const result = computeLayout({ ...input, organization: "indra", morphology });
  const containers = new Map(result.containers.map(c => [c.id, c]));
  const byParent = new Map<string, LayoutNode[]>();
  for (const node of input.nodes) if (node.parent) {
    const list = byParent.get(node.parent) ?? []; list.push(node); byParent.set(node.parent, list);
    const parent = containers.get(node.parent);
    assert.ok(parent);
    const point = result.positions.get(node.id)!;
    const childRadius = containers.get(node.id)?.radius ?? (5 + Math.max(0, Math.min(1, node.size)) * 5);
    // Containment is a 3D invariant: the child sphere lies inside its parent shell with a margin.
    assert.ok(Math.hypot(point.x - parent.center.x, point.y - parent.center.y, point.z - parent.center.z) + childRadius <= parent.radius * 0.94);
  }
  for (const siblings of byParent.values()) for (let a = 0; a < siblings.length; a++) for (let b = a + 1; b < siblings.length; b++) {
    const left = containers.get(siblings[a]!.id), right = containers.get(siblings[b]!.id);
    const leftRadius = left?.radius ?? 5 + siblings[a]!.size * 5;
    const rightRadius = right?.radius ?? 5 + siblings[b]!.size * 5;
    const leftPoint = result.positions.get(siblings[a]!.id)!, rightPoint = result.positions.get(siblings[b]!.id)!;
    // Sibling spheres never overlap in 3D.
    assert.ok(Math.hypot(leftPoint.x - rightPoint.x, leftPoint.y - rightPoint.y, leftPoint.z - rightPoint.z) + 1e-7 >= leftRadius + rightRadius);
  }
  assert.deepEqual([...new Set(result.containers.map(c => c.level))].sort(), [0, 1, 2, 3, 4]);
  const absolute = containers.get(ABSOLUTE_CONTAINER_ID)!;
  const roots = result.containers.filter(container => container.level === 1);
  for (let a = 0; a < roots.length; a++) for (let b = a + 1; b < roots.length; b++)
    assert.ok(xy(roots[a]!.center, roots[b]!.center) + 1e-7 >= roots[a]!.radius + roots[b]!.radius);
  for (const root of roots)
    assert.ok(Math.hypot(Math.hypot(root.center.x, root.center.y) + root.radius, root.center.z - absolute.center.z) <= absolute.radius * 0.94 + 1e-7);
  for (const point of result.positions.values())
    assert.ok(Math.hypot(point.x, point.y, point.z - absolute.center.z) < absolute.radius);
  }
});

test("eight Indra domains including three bare pearls fill the absolute disc", () => {
  const nodes: LayoutNode[] = Array.from({ length: 8 }, (_, i) => ({ id: `domain:${i}`, level: 1, parent: null, size: 0.5, domains: [] }));
  for (let i = 0; i < 5; i++) {
    nodes.push({ id: `project:${i}`, level: 2, parent: `domain:${i}`, size: 0.5, domains: [] });
    for (let j = 0; j < 4; j++) nodes.push({ id: `conversation:${i}:${j}`, level: 3, parent: `project:${i}`, size: 0.3, domains: [] });
  }
  const result = computeLayout({ nodes, edges: [], organization: "indra", morphology: "stellar" });
  const absolute = result.containers.find(c => c.id === ABSOLUTE_CONTAINER_ID)!;
  const domains = result.containers.filter(c => c.level === 1);
  // The absolute 2D rim is tight: it just encloses the packed domain shells.
  const tight = Math.max(...domains.map(c => Math.hypot(c.center.x, c.center.y) + c.radius));
  assert.ok(Math.abs(absolute.radius2d! * 0.94 - tight) < 1e-7);
  // Each domain sphere lies inside the absolute shell in three dimensions.
  for (const c of domains)
    assert.ok(Math.hypot(Math.hypot(c.center.x, c.center.y) + c.radius, c.center.z) <= absolute.radius * 0.94 + 1e-7);
  // The three bare pearls keep their own size rather than growing with the packed domains.
  const bare = domains.filter(c => c.radius < 10);
  assert.equal(bare.length, 3);
});

test("a large Indra child leaves room for thirty small siblings without growing the parent", () => {
  const items = [{ id: "large", radius: 100 }, ...Array.from({ length: 30 }, (_, i) => ({ id: `small:${i}`, radius: 5 }))];
  const packed = packDiscs(items, 7);
  assert.deepEqual(packed, packDiscs(items, 7));
  const discs = [...packed.values()];
  const parentRadius = Math.max(...discs.map(disc => Math.hypot(disc.x, disc.y) + disc.radius + 7)) / 0.94;
  assert.ok(parentRadius < 160, `parent radius ${parentRadius.toFixed(2)}`);
  for (let i = 0; i < discs.length; i++) {
    const a = discs[i]!;
    assert.ok(Math.hypot(a.x, a.y) + a.radius + 7 <= parentRadius * 0.94 + 1e-7);
    for (let j = i + 1; j < discs.length; j++) {
      const b = discs[j]!;
      assert.ok(Math.hypot(a.x - b.x, a.y - b.y) + 1e-7 >= a.radius + b.radius + 7);
    }
  }
});

test("phyllotaxis keeps eighty varied siblings separated and deterministic", () => {
  const items = Array.from({ length: 80 }, (_, i) => ({ id: `sibling:${i}`, radius: 4 + i % 9 }));
  const first = packDiscs(items, 7);
  assert.deepEqual(first, packDiscs(items, 7));
  const discs = [...first.values()];
  for (let i = 0; i < discs.length; i++) for (let j = i + 1; j < discs.length; j++) {
    const a = discs[i]!, b = discs[j]!;
    assert.ok(Math.hypot(a.x - b.x, a.y - b.y) + 1e-7 >= a.radius + b.radius + 7);
  }
});

test("collapsed domains become bounded pearls with visible gaps and a separate XYZ shell", () => {
  const nodes: LayoutNode[] = [
    { id: "collapsed", level: 1, parent: null, size: 0.5, hiddenDescendants: 100, domains: [] },
    { id: "collapsed-huge", level: 1, parent: null, size: 0.5, hiddenDescendants: 10000, domains: [] },
    { id: "expanded", level: 1, parent: null, size: 0.5, domains: [] },
    ...Array.from({ length: 12 }, (_, i): LayoutNode => ({ id: `child:${i}`, level: 2, parent: "expanded", size: 0.5, domains: [] })),
  ];
  const result = computeLayout({ nodes, edges: [], organization: "indra", morphology: "stellar" });
  const collapsed = result.containers.find(c => c.id === "collapsed")!;
  const expanded = result.containers.find(c => c.id === "expanded")!;
  const huge = result.containers.find(c => c.id === "collapsed-huge")!;
  const absolute = result.containers.find(c => c.id === ABSOLUTE_CONTAINER_ID)!;
  assert.ok(collapsed.radius > 3 * pearlRadius({ ...nodes[0]!, hiddenDescendants: 0 }));
  assert.ok(collapsed.radius <= expanded.radius);
  assert.ok(huge.radius <= expanded.radius);
  assert.ok(xy(collapsed.center, expanded.center) >= collapsed.radius + expanded.radius + 8 - 1e-7);
  const roots = result.containers.filter(c => c.level === 1);
  const meanRoot = roots.reduce((sum, root) => sum + root.radius, 0) / roots.length;
  for (let i = 0; i < roots.length; i++) for (let j = i + 1; j < roots.length; j++)
    assert.ok(xy(roots[i]!.center, roots[j]!.center) + 1e-7 >= roots[i]!.radius + roots[j]!.radius + Math.max(8, meanRoot * 0.06));
  assert.ok(layoutStats(result.positions).depthRatio >= DEPTH_RATIO_MIN);
  assert.ok(absolute.radius > absolute.radius2d!);
  for (const node of nodes) {
    const point = result.positions.get(node.id)!;
    const radius = result.containers.find(c => c.id === node.id)?.radius ?? pearlRadius(node);
    assert.ok(Math.hypot(Math.hypot(point.x, point.y) + radius, point.z - absolute.center.z) <= absolute.radius * 0.94 + 1e-7);
  }
  for (const ring of result.containers.filter(c => c.level > 0))
    assert.ok(Math.hypot(Math.hypot(ring.center.x, ring.center.y) + ring.radius,
      ring.center.z - absolute.center.z) <= absolute.radius * 0.94 + 1e-7);
});

test("Indra depth remains readable after disclosing a large proposal page", () => {
  const overview: LayoutNode[] = Array.from({ length: 8 }, (_, i) => ({ id: `domain:${i}`, level: 1, parent: null, size: 0.5, domains: [] }));
  overview.push(...Array.from({ length: 8 }, (_, i) => ({ id: `project:${i}`, level: 2 as const, parent: `domain:${i}`, size: 0.5, domains: [] })));
  const expanded: LayoutNode[] = [...overview, { id: 'conversation', level: 3, parent: 'project:0', size: 0.5, domains: [] },
    ...Array.from({ length: 60 }, (_, i): LayoutNode => ({ id: `proposal:${i}`, level: 4, parent: 'conversation', size: 0.2, domains: [] }))];
  for (const nodes of [overview, expanded]) {
    const input: LayoutInput = { nodes, edges: [], organization: 'indra', morphology: 'stellar' };
    const result = computeLayout(input);
    assert.ok(layoutStats(result.positions).depthRatio >= DEPTH_RATIO_MIN);
    const shallow = computeLayout({ ...input, expandZ: 0.5 });
    assert.ok(Math.abs(layoutStats(shallow.positions).depthRatio - layoutStats(result.positions).depthRatio * 0.5) < 1e-8);
  }
});

test("Flat 2D stays planar while Flat 3D becomes a real volume", () => {
  const input = fixture(500);
  const planar = computeLayout(input);
  assert.equal(planar.source, "flat-community");
  assert.equal(planar.containers.length, 0);
  for (let a = 0; a < input.nodes.length; a++) for (let b = a + 1; b < input.nodes.length; b++) {
    const left = input.nodes[a]!, right = input.nodes[b]!;
    const minimum = (21 * 1.45 / Math.sqrt(0.55)) * (0.72 + (10 + Math.min(1, left.size) * 5 + Math.min(1, right.size) * 5) / 24);
    assert.ok(xy(planar.positions.get(left.id)!, planar.positions.get(right.id)!) + 1e-9 >= minimum);
  }
  for (const point of planar.positions.values()) assert.equal(point.z, 0);
  const volumetric = computeLayout({ ...input, projection: "3d" });
  assert.equal(volumetric.source, "flat-community");
  assert.ok([...volumetric.positions.values()].some(point => point.z !== 0));
  const stats = volumeStats(volumetric.positions);
  assert.ok(stats.ratios.third >= 0.25, `λ3/λ1 ${stats.ratios.third.toFixed(3)}`);
});

test('realistic hierarchy has deterministic 3D spacing and balances to a ball', () => {
  const nodes: LayoutNode[] = [];
  for (let i = 0; i < 8; i++) nodes.push({ id: `domain:${i}`, level: 1, parent: null, size: 0.7, domains: [] });
  for (let i = 0; i < 31; i++) nodes.push({ id: `project:${i}`, level: 2, parent: `domain:${i % 8}`, size: 0.5, domains: [] });
  for (let i = 0; i < 165; i++) nodes.push({ id: `conversation:${i}`, level: 3, parent: `project:${i % 31}`, size: 0.3, domains: [] });
  for (let i = 0; i < 220; i++) nodes.push({ id: `proposal:${i}`, level: 4, parent: `conversation:${i % 165}`, size: 0.1, domains: [] });
  const input: LayoutInput = { nodes, edges: nodes.filter(n => n.parent).map(n => ({ id: `edge:${n.id}`, source: n.parent!, target: n.id, class: 'attested' })), organization: 'flat', morphology: 'stellar', projection: '3d' };
  const first = computeLayout(input), second = computeLayout(input);
  assert.deepEqual(first, second);
  assert.ok(volumeStats(first.positions).ratios.third >= 0.25);
  const points = nodes.map(n => first.positions.get(n.id)!);
  for (let a = 0; a < points.length; a++) for (let b = a + 1; b < points.length; b++)
    assert.ok(Math.hypot(points[a]!.x - points[b]!.x, points[a]!.y - points[b]!.y, points[a]!.z - points[b]!.z) > 20);
  const balanced = applyExpansion(first.positions, equilibrate(first.positions));
  assert.ok(volumeStats(balanced).ratios.third >= 0.6);
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
    const dashes: number[][] = [];
    const context = {
      canvas: { width: 200, height: 200, getBoundingClientRect: () => ({ width: 200, height: 200 }) },
      setTransform() {}, clearRect() {}, setLineDash(pattern: number[]) { dashes.push(pattern); }, beginPath() {}, moveTo() {}, lineTo() {}, stroke() { strokes++; },
    } as unknown as CanvasRenderingContext2D;
    drawMorphologyCanvas(context, geometry, point => ({ x: point.x + 100 + (projection === "3d" ? point.z * 0.4 : 0), y: point.y + 100 + (projection === "3d" ? point.z * 0.2 : 0), scale: 1 }),
      { fieldColor: "rgb(0, 0, 0)", nodes: new Map(), edges: new Map() }, undefined, container, projection);
    assert.ok(strokes > 0);
    // No dashed or dotted rim anywhere.
    assert.ok(dashes.every(pattern => pattern.length === 0));
  }
});

test("3D communities are separated clusters: centres at least 3× the intra-community radius", () => {
  const roots: LayoutNode[] = Array.from({ length: 8 }, (_, i) => ({ id: `community:${i}`, level: 1 as const, parent: null, size: 0.9, domains: [] }));
  const nodes: LayoutNode[] = [...roots];
  const edges: LayoutEdge[] = [];
  for (let i = 0; i < 8; i++) for (let j = 0; j < 12; j++) {
    const id = `community:${i}:node:${j}`;
    nodes.push({ id, level: 2 as const, parent: `community:${i}`, size: 0.5, domains: [] });
    edges.push({ id: `edge:${id}`, source: `community:${i}`, target: id, class: 'attested' });
  }
  const result = computeLayout({ nodes, edges, organization: 'flat', morphology: 'stellar', projection: '3d' });
  const centre = (i: number) => result.positions.get(`community:${i}`)!;
  const meanIntra = roots.reduce((sum, root, i) => {
    const members = nodes.filter(n => n.parent === root.id).map(n => result.positions.get(n.id)!);
    return sum + members.reduce((total, m) => total + Math.hypot(m.x - centre(i).x, m.y - centre(i).y, m.z - centre(i).z), 0) / members.length;
  }, 0) / roots.length;
  let inter = 0, pairs = 0;
  for (let a = 0; a < 8; a++) for (let b = a + 1; b < 8; b++) {
    inter += Math.hypot(centre(a).x - centre(b).x, centre(a).y - centre(b).y, centre(a).z - centre(b).z);
    pairs++;
  }
  const meanInter = inter / pairs;
  assert.ok(meanInter >= 3 * meanIntra, `inter ${meanInter.toFixed(1)} < 3× intra ${meanIntra.toFixed(1)}`);
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
