import assert from "node:assert/strict";
import test from "node:test";
import { buildMorphologyGeometry, neuralPrincipalTrunks, neuralTrunkLobeStrength } from "#engine/morphology-geometry.ts";
import { neuralBranchRoute } from "#engine/neural-trunks.ts";
import { neuralBranchedWidthPx, neuralEdgeEndOnSoma, somaOutlineRadiusAtAngle } from "#render-common/morphology-canvas.ts";

const hub = { id: "hub", position: { x: 0, y: 0, z: 0 }, radius: 8 };
const nodes = [hub, ...Array.from({ length: 24 }, (_, index) => {
  const angle = index * Math.PI / 12;
  return { id: `leaf-${index}`, position: { x: 150 * Math.cos(angle),
    y: 150 * Math.sin(angle), z: (index % 3 - 1) * 2 }, radius: 3 };
})];
const edges = nodes.slice(1).map((node, index) => ({ id: `edge-${index}`, source: hub.id,
  target: node.id, width: index < 4 ? 3 : 1 }));

test("A2c arbor partitions real relations through deterministic recursive splits", () => {
  const first = buildMorphologyGeometry("neural", nodes, edges);
  const again = buildMorphologyGeometry("neural", nodes, [...edges].reverse());
  assert.deepEqual(first.nodes[0]!.arbors, again.nodes[0]!.arbors);
  assert.equal(buildMorphologyGeometry("neural", nodes, edges), first, "drawn-subset cache");
  const roots = first.nodes[0]!.arbors!;
  assert.deepEqual(roots.flatMap(root => root.edgeIds).sort(), edges.map(edge => edge.id).sort());
  assert.ok(roots.some(root => root.children.some(child => child.children.length > 0)), "two branch levels");
  for (const root of roots) {
    const walk = (parent: typeof root): void => {
      if (parent.children.length) {
        assert.ok(parent.children.length >= 2 && parent.children.length <= 3);
        assert.deepEqual(parent.children.flatMap(child => child.edgeIds).sort(), [...parent.edgeIds].sort());
      }
      for (const child of parent.children) {
        assert.ok(Math.abs(child.widthFactor / parent.widthFactor - 0.76) < 1e-9);
        assert.ok(child.distance > parent.distance);
        walk(child);
      }
    };
    walk(root);
    for (const id of root.edgeIds) assert.ok(neuralBranchRoute(root, id).length >= 1);
  }
  assert.equal(first.edges.length, edges.length);
  assert.deepEqual(first.edges.map(edge => edge.id), edges.map(edge => edge.id));
  assert.ok(first.edges.every(edge => edge.segments.length === 1));
  // D084-W2-NEURAL BEGIN: the spindle is gone — the hub body is round and compact, and
  // only its real trunk directions extend it, through moderate broad lobes.
  assert.equal(first.nodes[0]!.spindleRatio, undefined);
  const shape = first.nodes[0]!;
  const trunks = neuralPrincipalTrunks(shape.trunks ?? []);
  const maximum = Math.max(1, ...trunks.map(trunk => trunk.weight));
  const lobes = trunks.map(trunk => ({ angle: Math.atan2(trunk.direction.y, trunk.direction.x),
    strength: neuralTrunkLobeStrength(trunk, maximum, shape.degree) }));
  const frame = { x: 0, y: 0, angle: Math.atan2(shape.axis.y, shape.axis.x),
    radius: 8, eccentricity: 1, harmonics: shape.outline, lobes };
  const forward = somaOutlineRadiusAtAngle(frame, frame.angle);
  const side = somaOutlineRadiusAtAngle(frame, frame.angle + Math.PI / 2);
  assert.ok(forward / side >= 1.05 && forward / side <= 1.6,
    `compact organic silhouette ${forward / side}`);
  const join = neuralEdgeEndOnSoma(frame, { x: 150 * Math.cos(frame.angle), y: 150 * Math.sin(frame.angle) });
  assert.ok(Math.hypot(join.x, join.y) < forward, "root begins inside the same soma outline");
  const radial = somaOutlineRadiusAtAngle({ ...frame, harmonics: [], lobes: [], angle: 0 }, 0.7);
  assert.ok(Math.abs(radial - 8) < 1e-9, "a bare body is exactly round at oblique angles");
  // D084-W2-NEURAL END
  const widths = [0, 10, 20].map(index => neuralBranchedWidthPx(index, 61, 2, 1, 8, 3.2));
  assert.ok(Math.abs(widths[1]! / widths[0]! - 0.76) < 1e-9);
  assert.ok(Math.abs(widths[2]! / widths[1]! - 0.76) < 1e-9);
});

test("A2c shared stems split continuously into curved routes with real endpoints", () => {
  const geometry = buildMorphologyGeometry("neural", nodes, edges);
  const root = geometry.nodes[0]!.arbors!.find(item => item.edgeIds.length >= 3)!;
  const paths = root.edgeIds.map(id => geometry.edges.find(edge => edge.id === id)!.segments[0]!);
  for (const path of paths.slice(1))
    assert.deepEqual(path.samples.slice(0, 6), paths[0]!.samples.slice(0, 6), "common stem is exact");
  const angle = (a: {x: number; y: number; z: number}, b: {x: number; y: number; z: number}) => {
    const length = Math.hypot(a.x, a.y, a.z) * Math.hypot(b.x, b.y, b.z);
    return Math.acos(Math.max(-1, Math.min(1, (a.x * b.x + a.y * b.y + a.z * b.z) / length)));
  };
  for (const path of paths) {
    const samples = path.samples;
    for (let join = 5; join < samples.length - 1; join += 5) {
      const before = { x: samples[join]!.x - samples[join - 1]!.x,
        y: samples[join]!.y - samples[join - 1]!.y, z: samples[join]!.z - samples[join - 1]!.z };
      const after = { x: samples[join + 1]!.x - samples[join]!.x,
        y: samples[join + 1]!.y - samples[join]!.y, z: samples[join + 1]!.z - samples[join]!.z };
      assert.ok(angle(before, after) < 0.55, `visible corner at ${path.edgeId}/${join}`);
    }
    const edge = edges.find(item => item.id === path.edgeId)!;
    const target = nodes.find(node => node.id === edge.target)!.position;
    assert.ok(Math.hypot(path.target.x - target.x, path.target.y - target.y, path.target.z - target.z) <= 4);
    assert.ok(path.samples.length >= 11, "route includes a split and a curved continuation");
  }
});
