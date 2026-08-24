import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { toVisualGraph } from "#adapter/projection.ts";
import { DEFAULT_CALIBRATION } from "#engine/calibration.ts";
import { createSemantic, semanticDigest } from "#engine/contract.ts";
import {
  MYCELIUM,
  NEURAL,
  STELLAR,
  applyMorphology,
  assertMorphologyBinding,
} from "#engine/morphology.ts";

/** This reads one fixture graph and does not supply morphology facts from semantic content. */
function graph() {
  return toVisualGraph(JSON.parse(readFileSync(join(process.cwd(), "..", "fixtures", "synthetic", "projection", "discovery-at-question.json"), "utf8")) as unknown);
}

test("all material profiles retain ids, incidence, and semantic identity", () => {
  const visualGraph = graph();
  const digest = semanticDigest(visualGraph);
  const profiles = [STELLAR, NEURAL, MYCELIUM];
  assert.equal(profiles.length, 3);
  for (const profile of profiles) {
    const binding = applyMorphology(visualGraph, profile, DEFAULT_CALIBRATION);
    assert.equal(binding.nodeIds.length, visualGraph.nodes.length);
    assert.equal(binding.edgeIds.length, visualGraph.edges.length);
    assert.equal(binding.incidence.length, visualGraph.edges.length);
    assert.equal(binding.nodes.length, visualGraph.nodes.length);
    assert.equal(binding.edges.length, visualGraph.edges.length);
    assert.deepEqual(binding.nodeIds, visualGraph.nodes.map((node) => node.id));
    assert.deepEqual(binding.edgeIds, visualGraph.edges.map((edge) => edge.id));
    assert.deepEqual(binding.incidence, visualGraph.edges.map((edge) => ({ id: edge.id, source: edge.source, target: edge.target })));
    assert.equal(semanticDigest(visualGraph), digest);
    assertMorphologyBinding(visualGraph, binding);
  }
  assert.equal(profiles.length, 3);
});

test("a morphology dropping one edge fails its binding assertion", () => {
  const visualGraph = graph();
  const binding = applyMorphology(visualGraph, STELLAR, DEFAULT_CALIBRATION);
  assert.ok(binding.edgeIds.length > 0);
  const dropped = { ...binding, edgeIds: binding.edgeIds.slice(1) };
  assert.equal(dropped.edgeIds.length + 1, visualGraph.edges.length);
  assert.throws(() => assertMorphologyBinding(visualGraph, dropped), /edge ids/);
});

test("a morphology writing a semantic capability fails the semantic invariant", () => {
  const visualGraph = graph();
  const before = semanticDigest(visualGraph);
  const binding = applyMorphology(visualGraph, NEURAL, DEFAULT_CALIBRATION);
  const node = visualGraph.nodes[0];
  assert.ok(node !== undefined);
  const mutableNode = node as { semantic: ReturnType<typeof createSemantic> };
  mutableNode.semantic = createSemantic(null);
  assertMorphologyBinding(visualGraph, binding);
  assert.notEqual(semanticDigest(visualGraph), before);
});
