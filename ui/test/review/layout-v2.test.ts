import assert from "node:assert/strict";
import { test } from "node:test";
import { performance } from "node:perf_hooks";
import { createHash } from "node:crypto";
import { ABSOLUTE_CONTAINER_ID, DEPTH_RATIO_MIN, computeLayout, layoutStats, packDiscs, pearlRadius, type LayoutEdge, type LayoutInput, type LayoutNode, type Point3 } from "../../src/review/layout-v2.ts";
import { applyExpansion, canonicalize, equilibrate, volumeStats } from "../../src/review/volume.ts";
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
  return { nodes, edges, organization: "natural", morphology: "stellar" };
}
const xy = (a: Point3, b: Point3) => Math.hypot(a.x - b.x, a.y - b.y);

test("layout determinism, incremental stability, depth and morphology membership", () => {
  const input = fixture(350);
  for (const organization of ["natural", "indra"] as const) {
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
    if (organization === "natural") {
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
  // Stellar packs each community densely; no two nodes overlap, and clusters are separated by a void.
  for (let a = 0; a < input.nodes.length; a++) for (let b = a + 1; b < input.nodes.length; b++) {
    const left = input.nodes[a]!, right = input.nodes[b]!;
    assert.ok(xy(planar.positions.get(left.id)!, planar.positions.get(right.id)!) + 1e-9 > 20);
  }
  for (const point of planar.positions.values()) assert.equal(point.z, 0);
  const volumetric = computeLayout({ ...input, projection: "3d" });
  assert.equal(volumetric.source, "flat-community");
  assert.ok([...volumetric.positions.values()].some(point => point.z !== 0));
  // The default anisotropy targets now hold on the canonicalised cloud (rotation + default scaling).
  const canonical = canonicalize(volumetric.positions);
  const stats = volumeStats(canonical);
  assert.ok(stats.ratios.second >= 0.5, `λ2/λ1 ${stats.ratios.second.toFixed(3)}`);
  assert.ok(stats.ratios.third >= 0.3, `λ3/λ1 ${stats.ratios.third.toFixed(3)}`);
});

test('realistic hierarchy has deterministic 3D spacing and balances to a ball', () => {
  const nodes: LayoutNode[] = [];
  for (let i = 0; i < 8; i++) nodes.push({ id: `domain:${i}`, level: 1, parent: null, size: 0.7, domains: [] });
  for (let i = 0; i < 31; i++) nodes.push({ id: `project:${i}`, level: 2, parent: `domain:${i % 8}`, size: 0.5, domains: [] });
  for (let i = 0; i < 165; i++) nodes.push({ id: `conversation:${i}`, level: 3, parent: `project:${i % 31}`, size: 0.3, domains: [] });
  for (let i = 0; i < 220; i++) nodes.push({ id: `proposal:${i}`, level: 4, parent: `conversation:${i % 165}`, size: 0.1, domains: [] });
  const input: LayoutInput = { nodes, edges: nodes.filter(n => n.parent).map(n => ({ id: `edge:${n.id}`, source: n.parent!, target: n.id, class: 'attested' })), organization: 'natural', morphology: 'stellar', projection: '3d' };
  const first = computeLayout(input), second = computeLayout(input);
  assert.deepEqual(first, second);
  const canonical = canonicalize(first.positions);
  assert.ok(volumeStats(canonical).ratios.second >= 0.5);
  assert.ok(volumeStats(canonical).ratios.third >= 0.3);
  const points = nodes.map(n => first.positions.get(n.id)!);
  for (let a = 0; a < points.length; a++) for (let b = a + 1; b < points.length; b++)
    assert.ok(Math.hypot(points[a]!.x - points[b]!.x, points[a]!.y - points[b]!.y, points[a]!.z - points[b]!.z) > 20);
  const balanced = applyExpansion(canonical, equilibrate(canonical));
  assert.ok(volumeStats(balanced).ratios.second >= 0.6, `balanced λ2/λ1 ${volumeStats(balanced).ratios.second.toFixed(3)}`);
  assert.ok(volumeStats(balanced).ratios.third >= 0.6, `balanced λ3/λ1 ${volumeStats(balanced).ratios.third.toFixed(3)}`);
});

test("unequal communities (one with 60% of the nodes) canonicalise and equilibrate to the target ratios", () => {
  const roots: LayoutNode[] = Array.from({ length: 8 }, (_, i) => ({ id: `domain:${i}`, level: 1 as const, parent: null, size: 0.9, domains: [] }));
  const nodes: LayoutNode[] = [...roots];
  const edges: LayoutEdge[] = [];
  // One community holds ~60% of the total node mass, reproducing the real overview's elongation.
  const memberCounts = [120, 8, 8, 8, 8, 8, 8, 8];
  memberCounts.forEach((count, i) => {
    for (let j = 0; j < count; j++) {
      const id = `domain:${i}:m:${j}`;
      nodes.push({ id, level: 2 as const, parent: `domain:${i}`, size: 0.5, domains: [] });
      edges.push({ id: `edge:${id}`, source: `domain:${i}`, target: id, class: 'attested' });
    }
  });
  const input: LayoutInput = { nodes, edges, organization: 'natural', morphology: 'stellar', projection: '3d' };
  const first = computeLayout(input), second = computeLayout(input);
  assert.deepEqual(first, second);
  const canonical = canonicalize(first.positions);
  const stats = volumeStats(canonical);
  assert.ok(stats.ratios.second >= 0.5, `λ2/λ1 ${stats.ratios.second.toFixed(3)}`);
  assert.ok(stats.ratios.third >= 0.3, `λ3/λ1 ${stats.ratios.third.toFixed(3)}`);
  const balanced = applyExpansion(canonical, equilibrate(canonical));
  assert.ok(volumeStats(balanced).ratios.second >= 0.6, `balanced λ2/λ1 ${volumeStats(balanced).ratios.second.toFixed(3)}`);
  assert.ok(volumeStats(balanced).ratios.third >= 0.6, `balanced λ3/λ1 ${volumeStats(balanced).ratios.third.toFixed(3)}`);
});

test("Stellar communities keep a void of at least 1.5× the mean cluster radius in 2D and 3D", () => {
  const roots: LayoutNode[] = Array.from({ length: 8 }, (_, i) => ({ id: `c${i}`, level: 1 as const, parent: null, size: 0.9, domains: [] }));
  const nodes: LayoutNode[] = [...roots];
  const edges: LayoutEdge[] = [];
  const memberCounts = [120, 8, 8, 8, 8, 8, 8, 8];
  memberCounts.forEach((count, i) => {
    for (let j = 0; j < count; j++) {
      const id = `c${i}:m${j}`;
      nodes.push({ id, level: 2 as const, parent: `c${i}`, size: 0.5, domains: [] });
      edges.push({ id: `e:${id}`, source: `c${i}`, target: id, class: 'attested' });
    }
  });
  for (const projection of ['2d', '3d'] as const) {
    const result = computeLayout({ nodes, edges, organization: 'natural', morphology: 'stellar', projection });
    const communities = result.communities!;
    assert.equal(communities.length, 8);
    assert.equal(communities.reduce((sum, community) => sum + community.count, 0), nodes.length);
    // The exposed per-community summary is what the browser check reads.
    const meanRadius = communities.reduce((sum, community) => sum + community.radius, 0) / communities.length;
    for (let a = 0; a < communities.length; a++) for (let b = a + 1; b < communities.length; b++) {
      const left = communities[a]!, right = communities[b]!;
      const distance = Math.hypot(left.center.x - right.center.x, left.center.y - right.center.y, left.center.z - right.center.z);
      assert.ok(distance >= left.radius + right.radius + 1.5 * meanRadius - 1e-6,
        `${projection} void ${(distance - left.radius - right.radius).toFixed(1)} vs ${(1.5 * meanRadius).toFixed(1)}`);
    }
  }
});

test("morphology owns its Flat layout: switching Stellar→Neural changes positions and switching back restores them exactly", () => {
  const roots: LayoutNode[] = Array.from({ length: 8 }, (_, i) => ({ id: `c${i}`, level: 1 as const, parent: null, size: 0.9, domains: [] }));
  const nodes: LayoutNode[] = [...roots];
  const edges: LayoutEdge[] = [];
  const memberCounts = [120, 8, 8, 8, 8, 8, 8, 8];
  memberCounts.forEach((count, i) => {
    for (let j = 0; j < count; j++) {
      const id = `c${i}:m${j}`;
      nodes.push({ id, level: 2 as const, parent: `c${i}`, size: 0.5, domains: [] });
      edges.push({ id: `e:${id}`, source: `c${i}`, target: id, class: 'attested' });
    }
  });
  const base = { nodes, edges, organization: 'natural' as const };
  const stellar = computeLayout({ ...base, morphology: 'stellar' });
  const neural = computeLayout({ ...base, morphology: 'neural' });
  const mycelium = computeLayout({ ...base, morphology: 'mycelium' });
  // Each morphology owns its own Flat layout; the Stellar cluster positions must not leak into Neural
  // or Mycelium (the organic layouts).
  assert.notDeepEqual(stellar.positions, neural.positions);
  assert.notDeepEqual(stellar.positions, mycelium.positions);
  assert.notDeepEqual(neural.positions, mycelium.positions);
  // Switching back to Stellar restores the exact positions (determinism).
  assert.deepEqual(computeLayout({ ...base, morphology: 'stellar' }).positions, stellar.positions);
  assert.deepEqual(computeLayout({ ...base, morphology: 'neural' }).positions, neural.positions);
});

test("2D Stellar layout is round, not a line: bounding-box aspect ratio ≥ 0.45 with one 60 % community", () => {
  const roots: LayoutNode[] = Array.from({ length: 8 }, (_, i) => ({ id: `c${i}`, level: 1 as const, parent: null, size: 0.9, domains: [] }));
  const nodes: LayoutNode[] = [...roots];
  const edges: LayoutEdge[] = [];
  // One community holds 60 % of the node mass, the real overview's worst case.
  const memberCounts = [120, 8, 8, 8, 8, 8, 8, 8];
  memberCounts.forEach((count, i) => {
    for (let j = 0; j < count; j++) {
      const id = `c${i}:m${j}`;
      nodes.push({ id, level: 2 as const, parent: `c${i}`, size: 0.5, domains: [] });
      edges.push({ id: `e:${id}`, source: `c${i}`, target: id, class: 'attested' });
    }
  });
  const result = computeLayout({ nodes, edges, organization: 'natural', morphology: 'stellar', projection: '2d' });
  const points = [...result.positions.values()];
  const box = layoutStats(result.positions).bbox;
  const width = box.x[1] - box.x[0];
  const height = box.y[1] - box.y[0];
  const aspect = Math.min(width, height) / Math.max(width, height);
  assert.ok(aspect >= 0.45, `2D Stellar aspect ratio ${aspect.toFixed(3)} < 0.45`);
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
  for (const [organization, budget] of [["natural", 300], ["indra", 100]] as const) {
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
      setTransform() {}, clearRect() {}, setLineDash(pattern: number[]) { dashes.push(pattern); }, beginPath() {}, moveTo() {}, lineTo() {}, stroke() { strokes++; }, arc() {}, fill() {},
      createRadialGradient: () => ({ addColorStop() {} }),
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
  const result = computeLayout({ nodes, edges, organization: 'natural', morphology: 'stellar', projection: '3d' });
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
  const result = computeLayout({ nodes, edges: [], organization: 'natural', morphology: 'stellar' });
  assert.equal(result.positions.size, nodes.length);
  assert.ok(performance.now() - start <= 300);
});

// ---------------------------------------------------------------- D-072 M2: degree-weighted hub room

/** Deterministic LCG: the realistic hub fixture below must be reproducible byte for byte. */
function hubFixtureLcg(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

/** A few hundred nodes, 8 communities, heavy-tailed relation degrees: each community has one
 * principal hub carrying 18–31 attested relations, bridges to the next hub, and low-degree noise. */
function hubFixture(): LayoutInput {
  const random = hubFixtureLcg(20260928);
  const nodes: LayoutNode[] = [];
  const edges: LayoutEdge[] = [];
  for (let c = 0; c < 8; c++) {
    const community = `community:${c}`;
    nodes.push({ id: community, level: 1, parent: null, size: 0.9, domains: [] });
    const projects = 3 + Math.floor(random() * 2);
    for (let p = 0; p < projects; p++) {
      const project = `${community}:project:${p}`;
      nodes.push({ id: project, level: 2, parent: community, size: 0.6, domains: [] });
      edges.push({ id: `tree:${project}`, source: community, target: project, class: "attested" });
      const conversations = 4 + Math.floor(random() * 3);
      for (let v = 0; v < conversations; v++) {
        const conversation = `${project}:conversation:${v}`;
        nodes.push({ id: conversation, level: 3, parent: project, size: 0.35, domains: [] });
        edges.push({ id: `tree:${conversation}`, source: project, target: conversation, class: "attested" });
        const proposals = 2 + Math.floor(random() * 3);
        for (let r = 0; r < proposals; r++) {
          const proposal = `${conversation}:proposal:${r}`;
          nodes.push({ id: proposal, level: 4, parent: conversation, size: 0.15, domains: [] });
          edges.push({ id: `tree:${proposal}`, source: conversation, target: proposal, class: "attested" });
        }
      }
    }
  }
  const byCommunity = new Map<string, string[]>();
  for (const node of nodes) {
    const root = node.id.split(":").slice(0, 2).join(":");
    const list = byCommunity.get(root) ?? [];
    list.push(node.id);
    byCommunity.set(root, list);
  }
  let relation = 0;
  for (let c = 0; c < 8; c++) {
    const hub = `community:${c}:project:0`;
    const members = (byCommunity.get(`community:${c}`) ?? []).filter(id => id !== hub);
    const degree = 18 + Math.floor(random() * 14);
    for (let k = 0; k < degree; k++) {
      const target = members[Math.floor(random() * members.length)]!;
      edges.push({ id: `rel:${relation++}`, source: hub, target, class: "attested" });
    }
    edges.push({ id: `rel:${relation++}`, source: hub, target: `community:${(c + 1) % 8}:project:0`, class: "attested" });
    const noise = 6 + Math.floor(random() * 5);
    for (let k = 0; k < noise; k++) {
      const a = members[Math.floor(random() * members.length)]!;
      const b = members[Math.floor(random() * members.length)]!;
      if (a !== b) edges.push({ id: `rel:${relation++}`, source: a, target: b, class: "exploratory" });
    }
  }
  return { nodes, edges, organization: "natural", morphology: "neural" };
}

type HubMetrics = {
  hubMin: number; hubMedian: number; meanEdge: number; bbox: number;
  intraMean: number; interCentre: number; crossings: number; clearance: number;
};
const weightedDegree = (nodes: readonly LayoutNode[], edges: readonly LayoutEdge[]): Map<string, number> => {
  const degree = new Map(nodes.map(node => [node.id, 0]));
  for (const edge of edges) {
    if (edge.source === edge.target) continue;
    const weight = edge.class === "attested" ? 1 : 0.5;
    if (degree.has(edge.source)) degree.set(edge.source, degree.get(edge.source)! + weight);
    if (degree.has(edge.target)) degree.set(edge.target, degree.get(edge.target)! + weight);
  }
  return degree;
};
function hubMetrics(input: LayoutInput, projection: "2d" | "3d"): HubMetrics {
  const result = computeLayout({ ...input, projection });
  const positions = result.positions;
  const planar = projection === "2d";
  const d3 = (a: Point3, b: Point3) => planar ? Math.hypot(a.x - b.x, a.y - b.y) : Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
  const degree = weightedDegree(input.nodes, input.edges);
  const hubs = [...degree.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 10).map(([id]) => id);
  const pairs: number[] = [];
  for (let i = 0; i < hubs.length; i++) for (let j = i + 1; j < hubs.length; j++)
    pairs.push(d3(positions.get(hubs[i]!)!, positions.get(hubs[j]!)!));
  pairs.sort((a, b) => a - b);
  const stats = layoutStats(positions);
  const width = stats.bbox.x[1] - stats.bbox.x[0], height = stats.bbox.y[1] - stats.bbox.y[0], depth = stats.bbox.z[1] - stats.bbox.z[0];
  let intraSum = 0, intraCount = 0;
  const centres: Point3[] = [];
  for (let c = 0; c < 8; c++) {
    const points = input.nodes.filter(node => node.id.startsWith(`community:${c}`)).map(node => positions.get(node.id)!);
    const centre = points.reduce((acc, p) => ({ x: acc.x + p.x / points.length, y: acc.y + p.y / points.length, z: acc.z + p.z / points.length }), { x: 0, y: 0, z: 0 });
    centres.push(centre);
    for (const p of points) { intraSum += d3(p, centre); intraCount++; }
  }
  let interSum = 0, interPairs = 0;
  for (let i = 0; i < centres.length; i++) for (let j = i + 1; j < centres.length; j++) { interSum += d3(centres[i]!, centres[j]!); interPairs++; }
  // proper crossings between disjoint relation segments on the view plane
  const segs = input.edges.map(edge => {
    const a = positions.get(edge.source)!, b = positions.get(edge.target)!;
    return { ax: a.x, ay: a.y, bx: b.x, by: b.y, s: edge.source, t: edge.target };
  });
  const orient = (p: { x: number; y: number }, q: { x: number; y: number }, r: { x: number; y: number }) =>
    Math.sign((q.y - p.y) * (r.x - q.x) - (q.x - p.x) * (r.y - q.y));
  let crossings = 0;
  for (let i = 0; i < segs.length; i++) for (let j = i + 1; j < segs.length; j++) {
    const p = segs[i]!, q = segs[j]!;
    if (new Set([p.s, p.t, q.s, q.t]).size < 4) continue;
    const d1 = orient({ x: p.ax, y: p.ay }, { x: p.bx, y: p.by }, { x: q.ax, y: q.ay });
    const d2 = orient({ x: p.ax, y: p.ay }, { x: p.bx, y: p.by }, { x: q.bx, y: q.by });
    const d3o = orient({ x: q.ax, y: q.ay }, { x: q.bx, y: q.by }, { x: p.ax, y: p.ay });
    const d4 = orient({ x: q.ax, y: q.ay }, { x: q.bx, y: q.by }, { x: p.bx, y: p.by });
    if (d1 * d2 < 0 && d3o * d4 < 0) crossings++;
  }
  // non-endpoint nodes within 21 units (one base spacing) of a relation segment
  let clearance = 0;
  for (const edge of input.edges) {
    const a = positions.get(edge.source)!, b = positions.get(edge.target)!;
    const vx = b.x - a.x, vy = b.y - a.y;
    const length2 = vx * vx + vy * vy;
    for (const node of input.nodes) {
      if (node.id === edge.source || node.id === edge.target) continue;
      const p = positions.get(node.id)!;
      const t = length2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * vx + (p.y - a.y) * vy) / length2)) : 0;
      if (Math.hypot(p.x - (a.x + t * vx), p.y - (a.y + t * vy)) < 21) clearance++;
    }
  }
  return {
    hubMin: pairs[0]!,
    hubMedian: pairs[Math.floor(pairs.length / 2)]!,
    meanEdge: input.edges.reduce((sum, edge) => sum + d3(positions.get(edge.source)!, positions.get(edge.target)!), 0) / input.edges.length,
    bbox: planar ? width * height : width * height * Math.max(depth, 1),
    intraMean: intraSum / intraCount,
    interCentre: interSum / interPairs,
    crossings,
    clearance,
  };
}

/** Pre-D072-M2 baseline (commit 8ed9dea, before the degree-weighted clearance) measured on the
 * fixture above with the same metric code. Re-baseline these literals only alongside a deliberate
 * retune of the hub constants. */
const HUB_BASELINES: Record<string, HubMetrics> = {
  "neural/2d": { hubMin: 58.7330, hubMedian: 1641.0344, meanEdge: 110.6630, bbox: 7251079.74, intraMean: 140.6184, interCentre: 1665.8297, crossings: 1705, clearance: 991 },
  "neural/3d": { hubMin: 50.9994, hubMedian: 1120.3391, meanEdge: 82.3134, bbox: 5382616128.11, intraMean: 90.5862, interCentre: 1268.0907, crossings: 1858, clearance: 4493 },
  "mycelium/2d": { hubMin: 36.9007, hubMedian: 1042.1269, meanEdge: 69.5869, bbox: 2915226.97, intraMean: 88.3476, interCentre: 1057.8782, crossings: 1705, clearance: 2103 },
  "mycelium/3d": { hubMin: 31.7522, hubMedian: 713.6439, meanEdge: 52.9922, bbox: 1386692010.27, intraMean: 58.0455, interCentre: 805.3353, crossings: 1893, clearance: 8322 },
};

test("degree-weighted clearance gives Neural and Mycelium hubs room without breaking communities", () => {
  const fixtureInput = hubFixture();
  for (const morphology of ["neural", "mycelium"] as const) {
    for (const projection of ["2d", "3d"] as const) {
      const key = `${morphology}/${projection}`;
      const before = HUB_BASELINES[key]!;
      const after = hubMetrics({ ...fixtureInput, morphology }, projection);
      // The defect was packed hubs: the closest top-10 hub pair must clearly grow.
      assert.ok(after.hubMin >= before.hubMin * 1.6, `${key}: hub min ${before.hubMin.toFixed(1)} → ${after.hubMin.toFixed(1)}`);
      // The canvas stays bounded: the median hub pair and the bounding box barely move.
      assert.ok(after.hubMedian >= before.hubMedian * 0.9, `${key}: hub median ${before.hubMedian.toFixed(1)} → ${after.hubMedian.toFixed(1)}`);
      assert.ok(after.hubMedian <= before.hubMedian * 1.3, `${key}: hub median ${before.hubMedian.toFixed(1)} → ${after.hubMedian.toFixed(1)}`);
      assert.ok(after.bbox <= before.bbox * 1.25, `${key}: bbox ×${(after.bbox / before.bbox).toFixed(3)}`);
      // Relations stay local within the bounded expansion.
      assert.ok(after.meanEdge <= before.meanEdge * 1.45, `${key}: mean edge ${before.meanEdge.toFixed(1)} → ${after.meanEdge.toFixed(1)}`);
      // Communities stay together: centres do not drift apart and cohesion stays above 3×.
      assert.ok(after.interCentre <= before.interCentre * 1.1, `${key}: inter-centre ${before.interCentre.toFixed(1)} → ${after.interCentre.toFixed(1)}`);
      assert.ok(after.interCentre >= 3 * after.intraMean, `${key}: inter ${after.interCentre.toFixed(1)} < 3× intra ${after.intraMean.toFixed(1)}`);
      // No new crossings: fewer segment crossings and fewer nodes pushed through clusters.
      assert.ok(after.crossings <= before.crossings, `${key}: crossings ${before.crossings} → ${after.crossings}`);
      assert.ok(after.clearance <= before.clearance, `${key}: clearance ${before.clearance} → ${after.clearance}`);
    }
  }
});

test("degree-weighted clearance keeps determinism, exact morphology switching and incremental stability", () => {
  const fixtureInput = hubFixture();
  for (const morphology of ["neural", "mycelium"] as const) {
    for (const projection of ["2d", "3d"] as const) {
      const input = { ...fixtureInput, morphology, projection };
      const first = computeLayout(input);
      assert.deepEqual(computeLayout(input).positions, first.positions);
      // D-071 morphology isolation: switching away and back restores the coordinates exactly,
      // because each morphology's layout is a pure function of its own input and the page never
      // seeds one morphology's layout with another's coordinates (v2-page gates `previous` on
      // the morphology being unchanged).
      const stellar = computeLayout({ ...input, morphology: "stellar" as const });
      const away = computeLayout({ ...input, morphology: morphology === "neural" ? "mycelium" as const : "neural" as const });
      assert.notDeepEqual(away.positions, first.positions);
      assert.notDeepEqual(stellar.positions, first.positions);
      assert.deepEqual(computeLayout(input).positions, first.positions);
      // Disclosing more nodes never moves what is already on screen, in every axis.
      const prefixNodes = fixtureInput.nodes.filter(node => node.level <= 2);
      const prefixEdges = fixtureInput.edges.filter(edge => prefixNodes.some(n => n.id === edge.source) && prefixNodes.some(n => n.id === edge.target));
      const prefix = computeLayout({ nodes: prefixNodes, edges: prefixEdges, organization: "natural", morphology, projection });
      const grown = computeLayout({ ...input, previous: prefix.positions });
      for (const [id, point] of prefix.positions) {
        const after = grown.positions.get(id)!;
        assert.equal(after.x, point.x);
        assert.equal(after.y, point.y);
        assert.equal(after.z, point.z);
      }
    }
  }
});

test("Stellar Flat coordinates are byte-identical to the pre-clearance digests", () => {
  const fixtureInput = hubFixture();
  const serialize = (positions: ReadonlyMap<string, Point3>) =>
    [...positions].map(([id, p]) => `${id}@${p.x.toFixed(6)},${p.y.toFixed(6)},${p.z.toFixed(6)}`).join(";");
  const digest = (value: string) => createHash("sha256").update(value).digest("hex");
  // Digests recorded on 8ed9dea, before the degree-weighted hub clearance existed: the packed
  // Stellar cluster grammar must never inherit the organic layouts' room.
  assert.equal(digest(serialize(computeLayout({ ...fixtureInput, morphology: "stellar", projection: "2d" }).positions)),
    "39d0893d94a8d2586f6432d5b3391fb1c19c993464c28b44ef3b27aa5d37dabb");
  assert.equal(digest(serialize(computeLayout({ ...fixtureInput, morphology: "stellar", projection: "3d" }).positions)),
    "5bc7a92400ccea590e55d00cececca13e714f7a9b6b72f15565cda31f5dc41e4");
  assert.equal(digest(JSON.stringify(computeLayout({ ...fixtureInput, morphology: "stellar", projection: "2d" }).communities)),
    "ab2c4cbfe5e8703628d84b2f3c494378acaefa3619afc40c9a3f0e3b2f6b456a");
  assert.equal(digest(JSON.stringify(computeLayout({ ...fixtureInput, morphology: "stellar", projection: "3d" }).communities)),
    "77024949b338e20b3088b386f70c654b1f5e625229b45b27cb951e9434b4ea5e");
  const prefixNodes = fixtureInput.nodes.filter(node => node.level <= 2);
  const prefixEdges = fixtureInput.edges.filter(edge => prefixNodes.some(n => n.id === edge.source) && prefixNodes.some(n => n.id === edge.target));
  const prefix = computeLayout({ nodes: prefixNodes, edges: prefixEdges, organization: "natural", morphology: "stellar" });
  assert.equal(digest(serialize(computeLayout({ ...fixtureInput, morphology: "stellar", previous: prefix.positions }).positions)),
    "a9aa5783b370cb74830924ab969225b3914dc9a139c5de5da0fc187c1bf889d8");
});

test("Neural and Mycelium 3D keep the canonical volume targets with hub room", () => {
  const fixtureInput = hubFixture();
  for (const morphology of ["neural", "mycelium"] as const) {
    const canonical = canonicalize(computeLayout({ ...fixtureInput, morphology, projection: "3d" }).positions);
    const ratios = volumeStats(canonical).ratios;
    assert.ok(ratios.second >= 0.5, `${morphology}: λ2/λ1 ${ratios.second.toFixed(3)}`);
    assert.ok(ratios.third >= 0.3, `${morphology}: λ3/λ1 ${ratios.third.toFixed(3)}`);
  }
});

test("relation-heavy 2500-node layouts stay within the flat budgets with hub clearance", () => {
  const nodes: LayoutNode[] = [];
  const edges: LayoutEdge[] = [];
  for (let c = 0; c < 8; c++) {
    nodes.push({ id: `c${c}`, level: 1, parent: null, size: 0.5, domains: [] });
    for (let p = 0; p < 40; p++) {
      const project = `c${c}:p${p}`;
      nodes.push({ id: project, level: 2, parent: `c${c}`, size: 0.4, domains: [] });
      edges.push({ id: `t${project}`, source: `c${c}`, target: project, class: "attested" });
      for (let v = 0; v < 7; v++) {
        const conversation = `${project}:v${v}`;
        nodes.push({ id: conversation, level: 3, parent: project, size: 0.2, domains: [] });
        edges.push({ id: `t${conversation}`, source: project, target: conversation, class: "attested" });
      }
    }
  }
  let relation = 0;
  for (let c = 0; c < 8; c++) for (let k = 0; k < 40; k++)
    edges.push({ id: `hub${relation++}`, source: `c${c}:p0`, target: `c${c}:p${1 + k % 39}:v${k % 7}`, class: "attested" });
  for (const projection of ["2d", "3d"] as const) {
    let best = Infinity;
    for (let run = 0; run < 3; run += 1) {
      const start = performance.now();
      const result = computeLayout({ nodes, edges, organization: "natural", morphology: "neural", projection });
      best = Math.min(best, performance.now() - start);
      assert.equal(result.positions.size, nodes.length);
    }
    assert.ok(best <= (projection === "2d" ? 300 : 600), `neural ${projection}: best ${best.toFixed(1)} ms`);
  }
});
