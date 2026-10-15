import assert from "node:assert/strict";
import test from "node:test";
import { buildMorphologyGeometry, somaLobeAngularWidth } from "#engine/morphology-geometry.ts";
import { MORPHOLOGY_CONTRACT } from "#engine/morphology-contract.ts";
import { DEFAULT_APPEARANCE } from "#engine/presentation-options.ts";
import { NEURAL_SOMA_MAX_VERTICES, neuralLeafRootWidthPx, neuralSomaFrames, somaLobeFactor,
  somaOutlineRadiusAtAngle, type NeuralSomaFrame, type MorphologyCanvasStyle } from "#render-common/morphology-canvas.ts";
import { buildNodeBuffers } from "#render3f/buffers.ts";
import { createNodeRenderResources, NODE_VERTEX_SHADER, NODE_FRAGMENT_SHADER } from "#render3f/node-material.ts";
import { FILAMENT_FRAGMENT_SHADER, neuralLongitudinalCoverageAt } from "#render3f/filament-material.ts";
import { buildScene } from "#scene/build.ts";
import { sceneFixtureGraph, sceneVisualState } from "#test-scene/support.ts";

const nodes = [
  { id: "hub", position: { x: 0, y: 0, z: 0 }, radius: 8 },
  { id: "leaf", position: { x: 100, y: 0, z: 0 }, radius: 8 },
  { id: "side", position: { x: 0, y: 100, z: 0 }, radius: 8 },
];
const edges = [
  { id: "east", source: "hub", target: "leaf", width: 2 },
  { id: "north", source: "hub", target: "side", width: 2 },
];
const geometry = buildMorphologyGeometry("neural", nodes, edges);
const style: MorphologyCanvasStyle = { fieldColor: "rgb(10, 10, 14)",
  nodes: new Map(nodes.map(node => [node.id, { color: "rgb(214, 226, 244)" }])),
  edges: new Map(edges.map(edge => [edge.id, { color: "rgb(150, 160, 178)" }])),
};
const project = (point: { x: number; y: number; z: number }) =>
  ({ x: point.x + point.z * 0.1, y: point.y, scale: 1 });
const appearance = { ...DEFAULT_APPEARANCE, glow: 0 };
const frame = (id: string, projection: "2d" | "3d") => neuralSomaFrames(geometry, project, style,
  MORPHOLOGY_CONTRACT.neural, appearance, projection).get(id)!;

test("degree-one soma has a real-edge broad lobe in both projections", () => {
  const leaf2d = frame("leaf", "2d"), leaf3d = frame("leaf", "3d");
  for (const leaf of [leaf2d, leaf3d]) {
    assert.equal(leaf.lobes?.length, 1);
    assert.ok(Math.abs(Math.abs(leaf.lobes![0]!.angle) - Math.PI) < 1e-6);
    assert.ok(somaOutlineRadiusAtAngle(leaf, Math.PI) > somaOutlineRadiusAtAngle(leaf, 0) * 1.2);
    // D084-W2-NEURAL: the long teardrop is gone — a degree-one cell keeps a compact body
    // whose single real direction carries one moderate, broad lobe.
    const plain = { ...leaf, lobes: [], lobeAreaScale: 1 };
    const extension = (somaOutlineRadiusAtAngle(leaf, Math.PI)
      - somaOutlineRadiusAtAngle(plain, Math.PI)) / leaf.radius;
    // D084-W2-NEURAL-R3: the body bump is small; the process supplies the shoulder.
    assert.ok(extension >= 0.03 && extension <= 0.10, `compact lobe/minor radius = ${extension}`);
  }
  assert.deepEqual(leaf2d.lobes, leaf3d.lobes);
  for (let i = 0; i < 64; i++) {
    const angle = 2 * Math.PI * i / 64;
    assert.equal(somaLobeFactor(leaf2d.lobes!, angle, leaf2d.lobeAreaScale),
      somaLobeFactor(leaf3d.lobes!, angle, leaf3d.lobeAreaScale));
  }
  assert.ok(NEURAL_SOMA_MAX_VERTICES <= 64);
});

test("low-degree lobes follow only connected directions and isolated nodes keep their glyph", () => {
  const hub = frame("hub", "2d");
  assert.equal(hub.lobes?.length, 2);
  for (const angle of [0, Math.PI / 2])
    assert.ok(hub.lobes!.some(lobe => Math.abs(lobe.angle - angle) < 1e-6));
  assert.ok(somaLobeFactor(hub.lobes!, Math.PI / 4, hub.lobeAreaScale) <
    Math.max(somaLobeFactor(hub.lobes!, 0, hub.lobeAreaScale),
      somaLobeFactor(hub.lobes!, Math.PI / 2, hub.lobeAreaScale)));
  const isolated = buildMorphologyGeometry("neural", [{ id: "alone", position: { x: 0, y: 0, z: 0 }, radius: 8 }], []);
  assert.equal(isolated.nodes[0]!.degree, 0);
  assert.deepEqual(isolated.nodes[0]!.trunks, []);
  assert.equal(somaLobeFactor([], 1.3), 1);
});

test("the low-degree protrusion holds its ribbon width without a concave neck", () => {
  const leaf = frame("leaf", "2d");
  const points = Array.from({ length: 4096 }, (_, index) => {
    const angle = 2 * Math.PI * index / 4096;
    const radius = somaOutlineRadiusAtAngle(leaf, angle);
    return { x: radius * Math.cos(angle), y: radius * Math.sin(angle) };
  });
  const tip = Math.min(...points.map(point => point.x));
  const ribbonWidth = Math.max(2, leaf.radius * 0.9);
  let previous = 0;
  for (let inset = 0.5; inset <= leaf.radius; inset += 0.5) {
    const x = tip + inset;
    const shoulder = points.filter(point => Math.abs(point.x - x) < 0.15);
    const width = 2 * Math.max(...shoulder.map(point => Math.abs(point.y)));
    assert.ok(width >= previous - 0.2, `shoulder forms a smooth chord at ${inset}: ${width} < ${previous}`);
    previous = width;
  }
  for (const inset of [1.5, 2, 3, 4, 5]) {
    const x = tip + inset;
    const shoulder = points.filter(point => Math.abs(point.x - x) < 0.15);
    assert.ok(shoulder.length > 0);
    const width = 2 * Math.max(...shoulder.map(point => Math.abs(point.y)));
    assert.ok(width >= ribbonWidth - 0.2, `inset ${inset}: soma ${width}, ribbon ${ribbonWidth}`);
  }
  const root = neuralLeafRootWidthPx(0, 2, leaf.radius);
  assert.ok(root >= 4, `root ${root} must be at least twice the shaft`);
  assert.equal(neuralLeafRootWidthPx(leaf.radius, 2, leaf.radius), 2);
  previous = root;
  for (let distance = 0.25; distance <= leaf.radius; distance += 0.25) {
    const width = neuralLeafRootWidthPx(distance, 2, leaf.radius);
    assert.ok(width <= previous + 1e-12);
    previous = width;
  }
});

test("new directional protrusions preserve prior soma area within five percent", () => {
  for (const node of ["hub", "leaf", "side"]) {
    const soma = frame(node, "2d");
    let before = 0, after = 0;
    for (let i = 0; i < 1024; i++) {
      const angle = 2 * Math.PI * i / 1024;
      const newFactor = somaLobeFactor(soma.lobes!, angle, soma.lobeAreaScale);
      const oldExtension = Math.max(0, ...soma.lobes!.map(lobe => {
        const delta = Math.atan2(Math.sin(angle - lobe.angle), Math.cos(angle - lobe.angle));
        return (0.12 + 1.8 * (lobe.strength - (lobe.strength > 0.6 ? 0.70 : 0.34)))
          * Math.exp(-0.5 * (delta / 0.34) ** 2);
      }));
      const plain = somaOutlineRadiusAtAngle(soma, angle) / newFactor;
      before += (plain * (1 + oldExtension)) ** 2;
      after += somaOutlineRadiusAtAngle(soma, angle) ** 2;
    }
    assert.ok(Math.abs(after / before - 1) < 0.05, `${node}: area ${after / before}`);
  }
});

test("GPU soma texture carries the same three bounded real trunk directions", () => {
  const graph = sceneFixtureGraph();
  const scene = buildScene(graph, { ...sceneVisualState(graph), morphology: "neural" });
  const template = scene.nodes[0]!;
  const shapes = new Map(geometry.nodes.map(node => [node.id, node]));
  const buffers = buildNodeBuffers(nodes.map(node => ({ ...template, id: node.id, position: node.position,
    radiusPx: node.radius })), scene.tokenEncoding, new Set(nodes.map(node => node.id)), shapes);
  const resources = createNodeRenderResources(buffers);
  const data = resources.haloStops.image.data;
  assert.ok(data instanceof Float32Array);
  for (const node of geometry.nodes) {
    const index = buffers.ids.indexOf(node.id);
    const trunks = node.trunks!.slice(0, 3);
    for (const [slot, trunk] of trunks.entries()) {
      const offset = index * (Math.max(1, buffers.haloStopCount) + 8) * 2
        + Math.max(1, buffers.haloStopCount) * 2 + slot * 4;
      assert.ok(Math.abs(data[offset]! - trunk.direction.x) < 1e-6);
      assert.ok(Math.abs(data[offset + 1]! - trunk.direction.y) < 1e-6);
      // D084-W2-NEURAL: every real direction now carries a moderate broad lobe (the old
      // 0.70–0.80 narrow teardrop strengths are the defect this cycle removes).
      assert.ok(data[offset + 3]! >= 0.04 - 1e-6 && data[offset + 3]! <= 0.09 + 1e-6);
    }
  }
  assert.equal(resources.geometry.attributes.a_somaLobe0, undefined, "no extra vertex attributes");
  assert.match(NODE_VERTEX_SHADER, /texelFetch\(u_haloStops/);
  assert.match(NODE_FRAGMENT_SHADER, /somaLobe\(v_somaLobe0/);
  assert.match(NODE_VERTEX_SHADER, /3\.6 : 1\.0/, "the leaf tip must fit inside the GPU quad");
  assert.equal(resources.geometry.getAttribute("position").count, 6);
  resources.haloStops.dispose();
  resources.geometry.dispose(); resources.material.dispose();
});

// D082-A-NEURAL BEGIN: P1 lines 67–74 require fewer, broader apparent hub directions.
test("canvas and GPU share the leaf shoulder and broaden hub lobes", () => {
  // D084-W2-NEURAL: every real trunk strength is now moderate (< 0.6), so every lobe —
  // leaf and hub alike — draws with the broad angular width in both renderers.
  assert.equal(somaLobeAngularWidth(frame("leaf", "2d").lobes![0]!.strength), 0.62);
  assert.equal(somaLobeAngularWidth(0.44), 0.62);
  assert.match(NODE_FRAGMENT_SHADER, /lobe\.z > 0\.6 \? 0\.32 : 0\.62/);
});
// D082-A-NEURAL END

test("GPU soma joint has full edge alpha and reconstructed centreline has no dark dip", () => {
  const alpha = 0.72;
  const fade = 0.05;
  for (const t of [0, 0.001, 0.01, 0.05, 0.1, 0.5])
    assert.equal(neuralLongitudinalCoverageAt(t, fade, true, true) * alpha, alpha);
  assert.equal(neuralLongitudinalCoverageAt(0, fade, false, true), 0);
  assert.equal(neuralLongitudinalCoverageAt(1, fade, true, false), 0);
  assert.match(FILAMENT_FRAGMENT_SHADER, /v_neuralProfile\.y > 0\.0 \? 1\.0/);
  assert.match(FILAMENT_FRAGMENT_SHADER, /v_neuralProfile\.z > 0\.0 \? 1\.0/);
  // Source-over coverage of a filled soma and the edge along a common centreline.
  // The outline occupies x <= 0; the hidden edge begins inside it at x = -3.
  const coverage = Array.from({ length: 81 }, (_, i) => {
    const x = -3 + i * 0.2;
    const soma = x <= 0 ? 0.9 : 0;
    const edge = alpha * neuralLongitudinalCoverageAt(i / 400, fade, true, true);
    return 1 - (1 - soma) * (1 - edge);
  });
  const shaft = coverage.slice(16);
  assert.ok(Math.min(...shaft) >= alpha * 0.9, `centreline dip ${Math.min(...shaft)} vs ${alpha}`);
});
