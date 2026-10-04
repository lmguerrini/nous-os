import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import test from "node:test";
import { buildMorphologyGeometry, neuralScreenWidthAt } from "#engine/morphology-geometry.ts";
import { clusterNeuralTrunks } from "#engine/neural-trunks.ts";
import { buildSceneBuffers } from "#render3f/buffers.ts";
import { createFilamentRenderResources } from "#render3f/filament-material.ts";
import { buildScene } from "#scene/build.ts";
import { sceneFixtureGraph, sceneVisualState } from "#test-scene/support.ts";

const hub = { id: "hub", position: { x: 0, y: 0, z: 0 }, radius: 8 };
const bearings = Array.from({ length: 16 }, (_, i) => i * Math.PI / 8);
const nodes = [hub, ...bearings.map((angle, i) => ({ id: `leaf-${i}`, position: {
  x: 110 * Math.cos(angle), y: 110 * Math.sin(angle), z: i % 3 }, radius: 3 }))];
const edges = bearings.map((_, i) => ({ id: `edge-${i}`, source: "hub", target: `leaf-${i}`, width: i < 3 ? 4 : 1 }));

test("D-080 A2b trunks are deterministic, capped, and partition real incident relations", () => {
  const first = buildMorphologyGeometry("neural", nodes, edges);
  const shuffled = buildMorphologyGeometry("neural", nodes, [...edges].reverse());
  const trunks = first.nodes[0]!.trunks!;
  assert.deepEqual(trunks, shuffled.nodes[0]!.trunks);
  assert.ok(trunks.length >= 2 && trunks.length <= 7);
  assert.deepEqual(trunks.flatMap(trunk => trunk.edgeIds).sort(), edges.map(edge => edge.id).sort());
  assert.equal(first.edges.length, edges.length);
  assert.equal(first.drawnSegments.length, edges.length);
  assert.deepEqual(first.edges.map(edge => [edge.id, edge.source, edge.target]),
    edges.map(edge => [edge.id, edge.source, edge.target]));
  assert.ok(trunks.some(trunk => trunk.edgeIds.length > 1));
  for (const trunk of trunks) {
    assert.ok(trunk.branchDistance >= 8 && trunk.branchDistance <= 48);
    assert.ok(trunk.rootWidthFactor >= 1 && trunk.rootWidthFactor <= 4);
    if (trunk.edgeIds.length < 2) continue;
    const paths = trunk.edgeIds.map(id => first.edges.find(edge => edge.id === id)!.segments[0]!);
    for (const path of paths.slice(1)) {
      for (let index = 1; index <= 5; index++)
        assert.deepEqual(path.samples[index], paths[0]!.samples[index], `shared root ${trunk.edgeIds.join(",")}`);
    }
    for (const path of paths) {
      const endpoint = nodes.find(node => node.id === first.edges.find(edge => edge.id === path.edgeId)!.target)!.position;
      assert.ok(Math.hypot(path.target.x - endpoint.x, path.target.y - endpoint.y, path.target.z - endpoint.z) <= 4);
    }
  }
  const rootShares = trunks.filter(trunk => trunk.edgeIds.length > 1).reduce((sum, trunk) => sum + trunk.edgeIds.length, 0) / edges.length;
  assert.ok(rootShares > 0.5);
  const ordinary = 1.5;
  const widths = Array.from({ length: 41 }, (_, i) => neuralScreenWidthAt(i / 40 * 0.2, ordinary, 8, 0,
    [3.2, 1], 120, [false, false]));
  for (let i = 1; i < widths.length; i++) assert.ok(widths[i]! <= widths[i - 1]! + 1e-9);
  assert.ok(widths[0]! / ordinary <= 4);
  mkdirSync("dist/evidence", { recursive: true });
  writeFileSync("dist/evidence/d080-neural-trunk-metrics.json", JSON.stringify({
    reference: "neuron-reference.png", degree: edges.length, trunkCount: trunks.length,
    maxRootToTipWidth: Math.max(...trunks.map(trunk => trunk.rootWidthFactor)),
    branchPoints: trunks.map(trunk => trunk.branchDistance),
    somaAspect: first.nodes[0]!.eccentricity,
    shareOfHubRootsMerged: rootShares,
    perTrunk: trunks.map(trunk => ({ edgeIds: trunk.edgeIds, rootWidthFactor: trunk.rootWidthFactor,
      branchDistance: trunk.branchDistance })),
  }, null, 2) + "\n");
});

test("the trunk clusterer is order independent in three dimensions", () => {
  const members = edges.map((edge, i) => ({ id: edge.id, direction: nodes[i + 1]!.position,
    length: 110, weight: edge.width }));
  assert.deepEqual(clusterNeuralTrunks(members), clusterNeuralTrunks([...members].reverse()));
});

test("dense 3D filaments share the trunk tangent with unchanged instances and endpoints", () => {
  const graph = sceneFixtureGraph();
  const base = buildScene(graph, { ...sceneVisualState(graph), morphology: "neural" });
  const template = base.edges.find(edge => edge.filament.hotMixPermille > 0)!;
  const nodeTemplate = base.nodes[0]!;
  const scene = { ...base,
    nodes: nodes.map(node => ({ ...nodeTemplate, id: node.id, position: node.position, radiusPx: node.radius })),
    edges: edges.map(edge => {
      const target = nodes.find(node => node.id === edge.target)!;
      return { ...template, id: edge.id, source: edge.source, target: edge.target,
        path: [hub.position, target.position],
        controlPoint: { x: target.position.x / 2, y: target.position.y / 2, z: target.position.z / 2 },
        bodyWidthPx: edge.width, propagation: { ...template.propagation, pathLength: 110 } };
    }), aggregates: [] };
  const buffers = buildSceneBuffers(scene);
  assert.equal(buffers.filaments.edgeIds.length, edges.length);
  const geometry = buildMorphologyGeometry("neural", nodes, edges);
  const trunk = geometry.nodes[0]!.trunks!.find(item => item.edgeIds.length >= 2)!;
  const controls = trunk.edgeIds.map(id => {
    const index = buffers.filaments.edgeIds.indexOf(id);
    assert.ok(index >= 0);
    assert.ok(buffers.filaments.neuralRootRatios[index * 2]! < 0);
    assert.deepEqual(Array.from(buffers.filaments.endPositions.slice(index * 3, index * 3 + 3)),
      [nodes.find(node => node.id === edges.find(edge => edge.id === id)!.target)!.position.x,
        nodes.find(node => node.id === edges.find(edge => edge.id === id)!.target)!.position.y,
        nodes.find(node => node.id === edges.find(edge => edge.id === id)!.target)!.position.z]
        .map(value => Math.fround(value)));
    return Array.from(buffers.filaments.controlPositions.slice(index * 3, index * 3 + 3));
  });
  for (const control of controls.slice(1)) assert.deepEqual(control, controls[0]);
  const resources = createFilamentRenderResources(buffers.filaments);
  assert.equal(resources.geometry.instanceCount, edges.length);
  assert.equal(resources.geometry.getAttribute("position").count, 6);
  resources.geometry.dispose(); resources.material.dispose();
});
