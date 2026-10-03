import assert from "node:assert/strict";
import test from "node:test";
import { buildMorphologyGeometry, neuralScreenWidthAt, neuralShoulderFraction, somaOutlineIrregularity } from "#engine/morphology-geometry.ts";
import { neuralEdgeEndOnSoma, somaOutlineRadiusAtAngle } from "#render-common/morphology-canvas.ts";
import { buildSceneBuffers } from "#render3f/buffers.ts";
import { buildScene } from "#scene/build.ts";
import { sceneFixtureGraph, sceneVisualState } from "#test-scene/support.ts";
import { FILAMENT_FRAGMENT_SHADER } from "#render3f/filament-material.ts";
import { NODE_FRAGMENT_SHADER } from "#render3f/node-material.ts";

const position = (x: number, y: number) => ({ x, y, z: 0 });

test("incident bundles deterministically pull the soma toward their weighted direction", () => {
  const nodes = [
    { id: "hub", position: position(0, 0), radius: 8 },
    { id: "east", position: position(100, 0), radius: 4 },
    { id: "north", position: position(0, 100), radius: 4 },
  ];
  const edges = [
    { id: "he", source: "hub", target: "east", width: 4 },
    { id: "hn", source: "hub", target: "north", width: 1 },
  ];
  const first = buildMorphologyGeometry("neural", nodes, edges);
  const reversed = buildMorphologyGeometry("neural", nodes, [...edges].reverse());
  const hub = first.nodes[0]!;
  assert.deepEqual(hub, reversed.nodes[0]);
  assert.ok(Math.abs(hub.axis.x) > Math.abs(hub.axis.y));
  assert.ok(somaOutlineIrregularity(hub.outline, 0) > somaOutlineIrregularity(hub.outline, Math.PI));
  const single = buildMorphologyGeometry("neural", nodes.slice(0, 2), edges.slice(0, 1)).nodes[0]!;
  assert.ok(single.outline[0]!.amplitude > 0);
  assert.ok(single.outline.reduce((sum, term) => sum + term.amplitude, 0) <= 0.12);
});

test("2D and 3D consume the same incident soma grammar; roots overlap and taper to body width", () => {
  const graph = sceneFixtureGraph();
  const scene = buildScene(graph, { ...sceneVisualState(graph), morphology: "neural" });
  const buffers = buildSceneBuffers(scene);
  const neuralEdges = scene.edges.filter(edge => edge.filament.hotMixPermille > 0);
  const geometry = buildMorphologyGeometry("neural",
    scene.nodes.map(node => ({ id: node.id, position: node.position, radius: node.radiusPx })),
    neuralEdges.map(edge => ({ id: edge.id, source: edge.source, target: edge.target, width: edge.bodyWidthPx })));
  const shapes = new Map(geometry.nodes.map(node => [node.id, node]));
  for (let i = 0; i < buffers.nodes.ids.length; i++) {
    const shape = shapes.get(buffers.nodes.ids[i]!)!;
    const offset = i * 4;
    assert.ok(Math.abs(buffers.nodes.somaAxisAndEccentricity[offset]! - shape.axis.x) < 1e-5);
    assert.ok(Math.abs(buffers.nodes.somaAxisAndEccentricity[offset + 3]! - shape.eccentricity) < 1e-5);
    assert.ok(Math.abs(buffers.nodes.somaHarmonics12[offset]! - shape.outline[0]!.amplitude) < 1e-5);
  }
  const frame = { x: 80, y: 80, angle: 0, radius: 8, eccentricity: 1.25, harmonics: geometry.nodes[0]!.outline };
  const root = neuralEdgeEndOnSoma(frame, { x: 200, y: 80 });
  const outline = somaOutlineRadiusAtAngle(frame, 0);
  assert.ok(outline - Math.hypot(root.x - frame.x, root.y - frame.y) > 0);
  const shoulder = neuralShoulderFraction(200, 8, 1.5);
  let previous = neuralScreenWidthAt(0, 1.5, 8, 8, undefined, 200);
  for (let step = 1; step <= 20; step++) {
    const width = neuralScreenWidthAt(shoulder * step / 20, 1.5, 8, 8, undefined, 200);
    assert.ok(width <= previous + 1e-9);
    previous = width;
  }
  assert.equal(previous, 1.5);
  assert.match(NODE_FRAGMENT_SHADER, /v_somaHarmonics12/);
  assert.match(FILAMENT_FRAGMENT_SHADER, /max\(v_widthsAndPicking\.z \* u_devicePixelRatio \* 0\.5/);
});
