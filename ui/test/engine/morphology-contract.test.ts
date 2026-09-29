import assert from "node:assert/strict";
import { test } from "node:test";
import { buildMorphologyGeometry, type MorphologySegment } from "#engine/morphology-geometry.ts";
import { MORPHOLOGY_CONTRACT, stellarIndra3dNodeRadiusPx } from "#engine/morphology-contract.ts";
import { FLAT, NATURAL } from "#engine/organization.ts";
import type { Coordinates } from "#engine/contract.ts";

const nodes = [
  { id: "h", position: { x: 0, y: 0, z: 2 }, radius: 5 },
  { id: "e", position: { x: 180, y: 1, z: 4 }, radius: 3 },
  { id: "w", position: { x: -180, y: -1, z: 0 }, radius: 3 },
  { id: "n", position: { x: 0, y: 180, z: 3 }, radius: 3 },
  { id: "s", position: { x: 0, y: -180, z: 1 }, radius: 3 },
];
const edges = ["e", "w", "n", "s", "e"].map((id, i) => ({ id: `edge${i}`, source: "h", target: id, width: 2 }));
const colony = [{ id: "c", members: nodes.map(node => node.id), center: nodes[0]!.position }];
const xy = (p: Coordinates) => ({ x: p.x, y: p.y });
function descriptor(part: MorphologySegment, project = xy) {
  const points = part.samples.map(project), a = points[0]!, b = points.at(-1)!;
  const dx = b.x - a.x, dy = b.y - a.y, length = Math.hypot(dx, dy) || 1;
  const offsets = points.map(p => ((p.x - a.x) * -dy + (p.y - a.y) * dx) / length);
  let inflections = 0, last = 0;
  for (let i = 1; i < offsets.length; i++) {
    const delta = offsets[i]! - offsets[i - 1]!;
    const sign = Math.abs(delta) < 1e-6 ? 0 : Math.sign(delta);
    if (sign && last && sign !== last) inflections++;
    if (sign) last = sign;
  }
  return { kind: part.path, deviation: Math.max(...offsets.map(Math.abs)) / length, inflections,
    taper: part.widthStart / part.widthEnd };
}
const near = (a: number, b: number, t = 0.02) => assert.ok(Math.abs(a - b) <= t, `${a} vs ${b}`);

test("3D geometry projected to XY matches geometry built from XY; rotated view preserves path language", () => {
  for (const morphology of ["stellar", "neural", "mycelium"] as const) {
    const world = buildMorphologyGeometry(morphology, nodes, edges, colony);
    const flat = buildMorphologyGeometry(morphology, nodes.map(n => ({ ...n, position: { ...n.position, z: 0 } })), edges,
      [{ ...colony[0]!, center: { ...colony[0]!.center, z: 0 } }]);
    assert.equal(world.drawnSegments.length, flat.drawnSegments.length);
    for (let i = 0; i < world.drawnSegments.length; i++) {
      const a = descriptor(world.drawnSegments[i]!), b = descriptor(flat.drawnSegments[i]!);
      assert.equal(a.kind, b.kind); near(a.deviation, b.deviation); assert.equal(a.inflections, b.inflections); near(a.taper, b.taper, 1e-9);
      const rotated = descriptor(world.drawnSegments[i]!, p => ({ x: p.x * 0.9 + p.z * 0.4, y: p.y }));
      assert.equal(rotated.kind, a.kind);
      if (morphology === "stellar") near(rotated.deviation, 0, 1e-9);
      if (morphology === "mycelium" && Math.hypot(a.deviation, b.deviation) > 0) assert.ok(rotated.inflections >= 2);
    }
    for (let i = 0; i < world.nodes.length; i++) {
      near(world.nodes[i]!.eccentricity, flat.nodes[i]!.eccentricity);
      near(Math.abs(Math.atan2(world.nodes[i]!.axis.y, world.nodes[i]!.axis.x) - Math.atan2(flat.nodes[i]!.axis.y, flat.nodes[i]!.axis.x)), 0, Math.PI / 18);
    }
  }
});

test("Stellar edges are collinear and halos stay within twice the core", () => {
  const geometry = buildMorphologyGeometry("stellar", nodes, edges);
  assert.ok(geometry.drawnSegments.every(p => descriptor(p).deviation < 1e-9));
  assert.ok(MORPHOLOGY_CONTRACT.stellar.glow.maximumCoreRatio <= 2);
});

test("Neural soma axis, eccentricity, topology and tangent", () => {
  const line = buildMorphologyGeometry("neural", nodes.slice(0, 3), edges.slice(0, 2));
  assert.ok(line.nodes[0]!.eccentricity > 1.1);
  assert.ok(Math.abs(Math.atan2(line.nodes[0]!.axis.y, line.nodes[0]!.axis.x)) < Math.PI / 18);
  const isotropic = buildMorphologyGeometry("neural", nodes, edges.slice(0, 4)).nodes[0]!;
  assert.ok(isotropic.eccentricity < 1.2);
  assert.ok(line.nodes.every(node => !("dendriteAngles" in node)));
  for (const part of line.drawnSegments) {
    const start = part.samples[0]!, next = part.samples[1]!;
    const tangent = Math.atan2(next.y - start.y, next.x - start.x);
    const exit = Math.atan2(part.target.y - part.source.y, part.target.x - part.source.x);
    assert.ok(Math.abs(Math.atan2(Math.sin(tangent - exit), Math.cos(tangent - exit))) < Math.PI / 12);
  }
});

test("Mycelium waves and varies width, with each shared trunk drawn once", () => {
  const geometry = buildMorphologyGeometry("mycelium", nodes, edges, colony);
  for (const part of geometry.drawnSegments) if (Math.hypot(part.target.x - part.source.x, part.target.y - part.source.y) > 40) {
    const d = descriptor(part);
    assert.ok(d.inflections >= 2, JSON.stringify(d));
    assert.ok(d.deviation >= 0.03 && d.deviation <= 0.06, JSON.stringify(d));
  }
  assert.ok(geometry.drawnSegments.some(p => p.widthStart !== p.widthEnd));
  const shared = geometry.drawnSegments.filter(p => p.sharedKey);
  assert.equal(shared.length, new Set(shared.map(p => p.sharedKey)).size);
  assert.ok(shared.length < geometry.edges.flatMap(e => e.segments).filter(p => p.sharedKey).length);
});

test("Mycelium keeps a visible, regular wave on short links", () => {
  const short = buildMorphologyGeometry("mycelium", [
    { id: "short-a", position: { x: 0, y: 0, z: 0 }, radius: 2 },
    { id: "short-b", position: { x: 20, y: 0, z: 0 }, radius: 2 },
  ], [{ id: "short-edge", source: "short-a", target: "short-b", width: 1 }]);
  const part = short.drawnSegments[0]!;
  assert.ok(Math.max(...part.samples.map(point => Math.abs(point.y))) >= 2);
  assert.ok(descriptor(part).inflections >= 2);
});

test("geometry is deterministic", () => {
  for (const morphology of ["stellar", "neural", "mycelium"] as const)
    assert.deepEqual(buildMorphologyGeometry(morphology, nodes, edges, colony), buildMorphologyGeometry(morphology, nodes, edges, colony));
});

test("organizations vocabulary is canonical natural/indra and the style-only path accepts the legacy flat alias", () => {
  for (const morphology of ["stellar", "neural", "mycelium"] as const) {
    assert.deepEqual(MORPHOLOGY_CONTRACT[morphology]!.organizations, ["natural", "indra"]);
  }
  assert.equal(stellarIndra3dNodeRadiusPx(12, "stellar", FLAT, "3d"), 12);
  assert.equal(stellarIndra3dNodeRadiusPx(12, "stellar", NATURAL, "3d"), 12);
  assert.equal(
    stellarIndra3dNodeRadiusPx(12, "stellar", "natural", "3d"),
    stellarIndra3dNodeRadiusPx(12, "stellar", "flat", "3d"),
  );
  assert.ok(Math.abs(stellarIndra3dNodeRadiusPx(12, "stellar", "indra", "3d") - 12 * 0.65) < 1e-9);
  assert.equal(stellarIndra3dNodeRadiusPx(12, "neural", "indra", "3d"), 12);
  assert.equal(stellarIndra3dNodeRadiusPx(12, "stellar", "indra", "2d"), 12);
});
