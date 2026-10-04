import assert from "node:assert/strict";
import test from "node:test";
import { buildMorphologyGeometry } from "#engine/morphology-geometry.ts";
import { MORPHOLOGY_CONTRACT } from "#engine/morphology-contract.ts";
import { DEFAULT_APPEARANCE } from "#engine/presentation-options.ts";
import { NEURAL_SOMA_MAX_VERTICES, neuralSomaFrames, somaLobeFactor,
  somaOutlineRadiusAtAngle, type NeuralSomaFrame, type MorphologyCanvasStyle } from "#render-common/morphology-canvas.ts";
import { buildNodeBuffers } from "#render3f/buffers.ts";
import { createNodeRenderResources, NODE_VERTEX_SHADER, NODE_FRAGMENT_SHADER } from "#render3f/node-material.ts";
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

test("degree-one soma has a real-edge teardrop in both projections", () => {
  const leaf2d = frame("leaf", "2d"), leaf3d = frame("leaf", "3d");
  for (const leaf of [leaf2d, leaf3d]) {
    assert.equal(leaf.lobes?.length, 1);
    assert.ok(Math.abs(Math.abs(leaf.lobes![0]!.angle) - Math.PI) < 1e-6);
    assert.ok(somaOutlineRadiusAtAngle(leaf, Math.PI) > somaOutlineRadiusAtAngle(leaf, 0) * 1.2);
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
  for (const inset of [1.5, 2, 3, 4, 5]) {
    const x = tip + inset;
    const shoulder = points.filter(point => Math.abs(point.x - x) < 0.15);
    assert.ok(shoulder.length > 0);
    const width = 2 * Math.max(...shoulder.map(point => Math.abs(point.y)));
    assert.ok(width >= ribbonWidth - 0.2, `inset ${inset}: soma ${width}, ribbon ${ribbonWidth}`);
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
        return (0.12 + 1.8 * (lobe.strength - 0.34)) * Math.exp(-0.5 * (delta / 0.34) ** 2);
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
      const offset = index * (Math.max(1, buffers.haloStopCount) + 6) * 2
        + Math.max(1, buffers.haloStopCount) * 2 + slot * 4;
      assert.ok(Math.abs(data[offset]! - trunk.direction.x) < 1e-6);
      assert.ok(Math.abs(data[offset + 1]! - trunk.direction.y) < 1e-6);
      assert.ok(data[offset + 3]! >= 0.34 && data[offset + 3]! <= 0.44);
    }
  }
  assert.equal(resources.geometry.attributes.a_somaLobe0, undefined, "no extra vertex attributes");
  assert.match(NODE_VERTEX_SHADER, /texelFetch\(u_haloStops/);
  assert.match(NODE_FRAGMENT_SHADER, /somaLobe\(v_somaLobe0/);
  assert.equal(resources.geometry.getAttribute("position").count, 6);
  resources.haloStops.dispose();
  resources.geometry.dispose(); resources.material.dispose();
});
