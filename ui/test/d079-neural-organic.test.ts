import assert from "node:assert/strict";
import test from "node:test";
import { buildMorphologyGeometry, neuralAngularBundles, neuralRootRatio, neuralScreenWidthAt, neuralShoulderFraction, somaOutlineIrregularity } from "#engine/morphology-geometry.ts";
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

test("angular bundles are deterministic, width weighted, and keep every incident edge", () => {
  const incident = [
    { id: "east-a", direction: position(1, 0), weight: 3 },
    { id: "east-b", direction: position(0.96, 0.28), weight: 2 },
    { id: "north", direction: position(0, 1), weight: 2 },
    { id: "west", direction: position(-1, 0), weight: 1 },
  ];
  const bundles = neuralAngularBundles(incident);
  assert.deepEqual(bundles, neuralAngularBundles([...incident].reverse()));
  assert.deepEqual(bundles[0]!.edgeIds, ["east-a", "east-b"]);
  assert.equal(bundles[0]!.weight, 5);
  assert.deepEqual(bundles.flatMap(bundle => bundle.edgeIds).sort(), incident.map(item => item.id).sort());
});

test("a hub's soma follows its strongest bundles instead of averaging to a round hub", () => {
  const nodes = [{ id: "hub", position: position(0, 0), radius: 10 },
    ...[0, 0.12, -0.12, Math.PI / 2, Math.PI / 2 + 0.1, Math.PI, -Math.PI / 2]
      .map((angle, i) => ({ id: `n${i}`, position: position(100 * Math.cos(angle), 100 * Math.sin(angle)), radius: 4 }))];
  const widths = [4, 3, 3, 2, 2, 0.5, 0.5];
  const edges = widths.map((width, i) => ({ id: `e${i}`, source: "hub", target: `n${i}`, width }));
  const hub = buildMorphologyGeometry("neural", nodes, edges).nodes[0]!;
  assert.equal(hub.bundles?.[0]?.weight, 10);
  assert.ok(hub.axis.x > 0.95);
  assert.ok(somaOutlineIrregularity(hub.outline, 0) > somaOutlineIrregularity(hub.outline, Math.PI));
  assert.ok(somaOutlineIrregularity(hub.outline, Math.PI / 2) > somaOutlineIrregularity(hub.outline, -Math.PI / 2));
  assert.equal(hub.degree, 7);
});

test("hub and secondary root ratios stay bounded and taper monotonically to the ordinary width", () => {
  assert.equal(neuralRootRatio(1), 1.8);
  assert.equal(neuralRootRatio(5), 1.8);
  assert.equal(neuralRootRatio(6), 2.6);
  for (const degree of [1, 8]) {
    const ratio = neuralRootRatio(degree);
    const ordinary = 1.5, radius = 10, span = 200;
    const shoulder = neuralShoulderFraction(span, radius, ordinary);
    let previous = neuralScreenWidthAt(0, ordinary, radius, radius, [ratio, ratio], span);
    assert.ok(Math.abs(previous / ordinary - ratio) < 1e-9);
    for (let step = 1; step <= 32; step++) {
      const width = neuralScreenWidthAt(shoulder * step / 32, ordinary, radius, radius, [ratio, ratio], span);
      assert.ok(width <= previous + 1e-9);
      previous = width;
    }
    assert.equal(previous, ordinary);
  }
});

test("3D filament ratios match the shared canvas profile at both endpoints", () => {
  const scene = buildScene(sceneFixtureGraph(), { ...sceneVisualState(sceneFixtureGraph()), morphology: "neural" });
  const buffers = buildSceneBuffers(scene);
  const geometry = buildMorphologyGeometry("neural", scene.nodes.map(node => ({ id: node.id, position: node.position, radius: node.radiusPx })),
    scene.edges.filter(edge => edge.filament.hotMixPermille > 0)
      .map(edge => ({ id: edge.id, source: edge.source, target: edge.target, width: edge.bodyWidthPx })));
  const shapes = new Map(geometry.nodes.map(node => [node.id, node]));
  for (let i = 0; i < buffers.filaments.edgeIds.length; i++) {
    if (buffers.filaments.neuralProfile[i * 4 + 3] !== 1) continue;
    const sourceRatio = neuralRootRatio(shapes.get(buffers.filaments.sourceIds[i]!)!.degree);
    const targetRatio = neuralRootRatio(shapes.get(buffers.filaments.targetIds[i]!)!.degree);
    // D082-A-NEURAL BEGIN: P1 merges close real directions even below degree eight.
    const edgeId = buffers.filaments.edgeIds[i]!;
    const sourceTrunk = shapes.get(buffers.filaments.sourceIds[i]!)!.trunks
      ?.find(trunk => trunk.edgeIds.length > 1 && trunk.edgeIds.includes(edgeId));
    const targetTrunk = shapes.get(buffers.filaments.targetIds[i]!)!.trunks
      ?.find(trunk => trunk.edgeIds.length > 1 && trunk.edgeIds.includes(edgeId));
    const expectedSource = sourceTrunk ? -sourceTrunk.rootWidthFactor : sourceRatio;
    const expectedTarget = targetTrunk ? -targetTrunk.rootWidthFactor : targetRatio;
    assert.ok(Math.abs(buffers.filaments.neuralRootRatios[i * 2]! - expectedSource) < 1e-5);
    assert.ok(Math.abs(buffers.filaments.neuralRootRatios[i * 2 + 1]! - expectedTarget) < 1e-5);
    // D082-A-NEURAL END
    const ordinary = 1.5, radius = 10;
    assert.equal(neuralScreenWidthAt(0, ordinary, radius, radius, [sourceRatio, targetRatio], 200), ordinary * sourceRatio);
  }
  assert.match(FILAMENT_FRAGMENT_SHADER, /v_neuralRootRatios\.x/);
});
