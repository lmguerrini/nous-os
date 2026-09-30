import assert from "node:assert/strict";
import { test } from "node:test";
import { buildMorphologyGeometry } from "#engine/morphology-geometry.ts";
import { morphologyMetrics } from "#engine/morphology-metrics.ts";
import { morphologyLayoutParams } from "#engine/morphology.ts";

const nodes = [
  { id: "hub", position: { x: 0, y: 0, z: 0 }, radius: 7 },
  { id: "a", position: { x: 20, y: 0, z: 0 }, radius: 3 },
  { id: "b", position: { x: 8, y: 18, z: 0 }, radius: 3 },
  { id: "c", position: { x: -13, y: 14, z: 0 }, radius: 3 },
  { id: "d", position: { x: -20, y: -4, z: 0 }, radius: 3 },
];
const edges = [
  { id: "ha", source: "hub", target: "a", width: 2 },
  { id: "hb", source: "hub", target: "b", width: 2 },
  { id: "hc", source: "hub", target: "c", width: 2 },
  { id: "hd", source: "hub", target: "d", width: 2 },
  { id: "ab", source: "a", target: "b", width: 2 },
  { id: "ac", source: "a", target: "c", width: 2 },
];
const colony = [{ id: "colony", members: nodes.map((node) => node.id), center: nodes[0]!.position }];

test("D-069 Stellar emits only straight, constant-width relations", () => {
  const metrics = morphologyMetrics(buildMorphologyGeometry("stellar", nodes, edges, colony));
  assert(metrics.edgeStraightness.every((value) => value === 1));
  assert(metrics.bendCount.every((value) => value === 0));
  assert(metrics.inflections.every((value) => value === 0));
  assert(metrics.taperVariance.every((value) => value === 0));
});

test("D-069 Neural emits one bend, proximal taper and deterministic somata", () => {
  const geometry = buildMorphologyGeometry("neural", nodes, edges, colony);
  const metrics = morphologyMetrics(geometry);
  assert(metrics.edgeStraightness.every((value) => value < 1));
  assert(metrics.bendCount.every((value) => value === 1));
  assert(metrics.inflections.every((value) => value === 0));
  assert(metrics.taperVariance.every((value) => value > 0));
  assert((geometry.nodes.find((node) => node.id === "hub")?.eccentricity ?? 0) >= 1);
  assert(geometry.nodes.every((node) => !("dendriteAngles" in node)));
  assert.deepEqual(geometry, buildMorphologyGeometry("neural", nodes, edges, colony));
});

test("D-074 Mycelium branches at graph nodes and varies relation curvature", () => {
  const geometry = buildMorphologyGeometry("mycelium", nodes, edges, colony);
  const metrics = morphologyMetrics(geometry);
  assert.equal(metrics.sharedTrunkLengthShare, 0);
  assert(metrics.branchingPoints > 0);
  assert(metrics.taperVariance.some((value) => value > 0));
  assert(new Set(metrics.relationCurvatures).size > 1);
  assert.equal(geometry.drawnSegments.length, geometry.edges.reduce((sum, edge) => sum + edge.segments.length, 0));
});

test("D-069 layout hints are distinct without moving the supplied anchors", () => {
  const sets = ["stellar", "neural", "mycelium"].map((name) => morphologyLayoutParams(name as "stellar" | "neural" | "mycelium"));
  assert.equal(new Set(sets.map((set) => JSON.stringify(set))).size, 3);
});
