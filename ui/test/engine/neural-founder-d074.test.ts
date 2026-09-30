import assert from "node:assert/strict";
import test from "node:test";
import { MORPHOLOGY_CONTRACT } from "#engine/morphology-contract.ts";
import { buildMorphologyGeometry, neuralDetailVisible, neuralScreenWidthAt, neuralShoulderFraction } from "#engine/morphology-geometry.ts";
import { DEFAULT_APPEARANCE } from "#engine/presentation-options.ts";
import { drawMorphologyCanvas, neuralEdgeEndOnSoma, somaOutlineRadiusAtAngle } from "#render-common/morphology-canvas.ts";
import type { MorphologyCanvasStyle } from "#render-common/morphology-canvas.ts";
import { FILAMENT_FRAGMENT_SHADER, createFilamentRenderResources } from "#render3f/filament-material.ts";
import { NODE_FRAGMENT_SHADER, createNodeRenderResources } from "#render3f/node-material.ts";
import { buildSceneBuffers } from "#render3f/buffers.ts";
import { buildScene } from "#scene/build.ts";
import { sceneFixtureGraph, sceneVisualState } from "#test-scene/support.ts";

test("Neural root reaches the actual soma outline and tapers monotonically over a short shoulder", () => {
  const frame = { x: 80, y: 80, angle: 0.3, radius: 7, eccentricity: 1.17, harmonics: [] };
  const root = neuralEdgeEndOnSoma(frame, { x: 220, y: 130 });
  const outline = somaOutlineRadiusAtAngle(frame, Math.atan2(root.y - frame.y, root.x - frame.x));
  assert.ok(Math.abs(outline - Math.hypot(root.x - frame.x, root.y - frame.y) - 0.5) < 1e-9);
  const shoulder = neuralShoulderFraction(240, 7, 1.5);
  assert.ok(shoulder < 0.28, "a long relation keeps the thick root local to its soma");
  let previous = neuralScreenWidthAt(0, 1.5, 7, 7, [2.4, 2.4], 240);
  assert.ok(previous >= 2.3 * 1.5);
  for (let step = 1; step <= 100; step++) {
    const width = neuralScreenWidthAt(shoulder * step / 100, 1.5, 7, 7, [2.4, 2.4], 240);
    assert.ok(width <= previous + 1e-9);
    previous = width;
  }
  assert.ok(Math.abs(previous - 1.5) < 1e-9);
  assert.equal(neuralScreenWidthAt(0.5, 1.5, 7, 7, [2.4, 2.4], 240), 1.5);
  assert.match(FILAMENT_FRAGMENT_SHADER, /startShoulder.*endShoulder/s);
});

test("cosmetic Neural sprouts appear only in close-up and never enter graph or GPU instance counts", () => {
  assert.equal(neuralDetailVisible(1, 7, 180), false);
  assert.equal(neuralDetailVisible(2, 7, 180), true);
  assert.equal(neuralDetailVisible(2, 4, 180), false);
  const nodes = [
    { id: "a", position: { x: 0, y: 0, z: 0 }, radius: 10 },
    { id: "b", position: { x: 180, y: 0, z: 0 }, radius: 10 },
  ];
  const geometry = buildMorphologyGeometry("neural", nodes, [{ id: "ab", source: "a", target: "b", width: 1 }]);
  const style: MorphologyCanvasStyle = {
    fieldColor: "rgb(0, 0, 0)",
    nodes: new Map(nodes.map(node => [node.id, { color: "rgb(220, 220, 220)" }])),
    edges: new Map([["ab", { color: "rgb(220, 220, 220)" }]]),
  };
  const strokes = (zoom: number, projection: "2d" | "3d", moving = false) => {
    let count = 0;
    const context = {
      canvas: { width: 600, height: 400, getBoundingClientRect: () => ({ width: 600, height: 400 }) },
      setTransform() {}, setLineDash() {}, clearRect() {}, beginPath() {}, closePath() {}, fill() {},
      moveTo() {}, lineTo() {}, arc() {}, quadraticCurveTo() {}, stroke() { count++; },
    } as unknown as CanvasRenderingContext2D;
    drawMorphologyCanvas(context, geometry, point => ({ x: 40 + point.x * zoom, y: 100 + point.y * zoom, scale: zoom }),
      { ...style, interaction: { hoverId: null, focusIds: null, quality: moving ? "moving" : "full" } },
      { ...DEFAULT_APPEARANCE, glow: 0, flowIntensity: 0 }, [], projection);
    return count;
  };
  assert.equal(strokes(1, "2d"), 0);
  assert.equal(strokes(1, "3d"), 0);
  assert.equal(strokes(2, "2d"), strokes(2, "3d"));
  assert.ok(strokes(2, "2d") > 0);
  assert.equal(strokes(2, "2d", true), 1, "moving frame uses only its one inexpensive base stroke");
  assert.equal(geometry.edges.length, 1);
  assert.equal(geometry.drawnSegments.length, 1);
  assert.equal(geometry.branchPoints.length, 0);

  const graph = sceneFixtureGraph();
  const scene = buildScene(graph, { ...sceneVisualState(graph), morphology: "neural" });
  const buffers = buildSceneBuffers(scene);
  const filaments = createFilamentRenderResources(buffers.filaments);
  const somata = createNodeRenderResources(buffers.nodes);
  const nodeById = new Map(scene.nodes.map(node => [node.id, node]));
  for (let index = 0; index < buffers.filaments.edgeIds.length; index++) {
    const source = nodeById.get(buffers.filaments.sourceIds[index]!)!;
    const target = nodeById.get(buffers.filaments.targetIds[index]!)!;
    for (const [array, node] of [[buffers.filaments.startPositions, source], [buffers.filaments.endPositions, target]] as const) {
      assert.ok(Math.abs(array[index * 3]! - node.position.x) < 1e-3);
      assert.ok(Math.abs(array[index * 3 + 1]! - node.position.y) < 1e-3);
      assert.ok(Math.abs(array[index * 3 + 2]! - node.position.z) < 1e-3);
    }
  }
  assert.equal(filaments.geometry.instanceCount, scene.edges.length);
  assert.equal(somata.geometry.instanceCount, scene.nodes.length);
  assert.match(FILAMENT_FRAGMENT_SHADER, /neuralBranchCoverage/);
  assert.match(NODE_FRAGMENT_SHADER, /v_somaShape/);
  assert.ok(buffers.nodes.somaShape.some((value, index) => index % 2 === 0 && value === 1));
  filaments.geometry.dispose(); filaments.material.dispose();
  somata.geometry.dispose(); somata.material.dispose(); somata.haloStops.dispose();
});

test("Neural halo stays tight and monochrome reference colours carry zero chroma", () => {
  assert.ok(MORPHOLOGY_CONTRACT.neural.glow.maximumCoreRatio <= 1.1);
  assert.ok(MORPHOLOGY_CONTRACT.neural.glow.strength <= 0.05);
  const graph = sceneFixtureGraph();
  const scene = buildScene(graph, { ...sceneVisualState(graph), morphology: "neural", palette: "monochrome" });
  const buffers = buildSceneBuffers(scene);
  for (const channels of [buffers.nodes.colorsSrgb, buffers.filaments.colorsSrgb])
    for (let i = 0; i < channels.length; i += 3) {
      assert.ok(Math.abs(channels[i]! - channels[i + 1]!) < 1e-6);
      assert.ok(Math.abs(channels[i + 1]! - channels[i + 2]!) < 1e-6);
    }
});
