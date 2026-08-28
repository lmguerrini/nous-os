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
  SHARED_SCENE_MATERIAL_TARGET,
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

test("morphology normalises prominence from rendered graph incidence and carries terminal and taper material", () => {
  const visualGraph = graph();
  const bindings = new Map([
    [STELLAR.id, applyMorphology(visualGraph, STELLAR, DEFAULT_CALIBRATION)],
    [NEURAL.id, applyMorphology(visualGraph, NEURAL, DEFAULT_CALIBRATION)],
    [MYCELIUM.id, applyMorphology(visualGraph, MYCELIUM, DEFAULT_CALIBRATION)],
  ]);
  const stellar = requiredBinding(bindings, STELLAR.id);
  const neural = requiredBinding(bindings, NEURAL.id);
  const mycelium = requiredBinding(bindings, MYCELIUM.id);
  const prominence = stellar.nodes.map((node) => node.prominencePermille);
  assert.equal(Math.min(...prominence), 0);
  assert.equal(Math.max(...prominence), 1000);
  for (const node of stellar.nodes) {
    assert.equal(node.facts.prominence.value, node.prominencePermille);
    assert.equal(node.facts.prominence.origin, "morphology:edge-incidence-normalised-within-rendered-graph-degree-range-not-authority");
  }
  const terminal = stellar.nodes.find((node) => node.facts.terminal.value === true);
  assert.ok(terminal !== undefined);
  const myceliumTerminal = requiredNode(mycelium, terminal.id);
  assert.ok(myceliumTerminal.coreSizePx < terminal.coreSizePx);
  assert.ok(neural.edges.some((edge) => edge.taperPermille < 1000));
  for (const edge of neural.edges) {
    const expected = DEFAULT_CALIBRATION.filament.baseWidthPx
      * DEFAULT_CALIBRATION.morphology.neural.filamentWidthMultiplierPermille
      * edge.taperPermille
      / (1000 * 1000);
    assert.equal(edge.widthPx, expected);
  }
  assert.notDeepEqual(
    stellar.nodes.map((node) => [node.coreSizePx, node.haloRadiusPx]),
    neural.nodes.map((node) => [node.coreSizePx, node.haloRadiusPx]),
  );
  assert.notDeepEqual(
    neural.nodes.map((node) => [node.coreSizePx, node.haloRadiusPx]),
    mycelium.nodes.map((node) => [node.coreSizePx, node.haloRadiusPx]),
  );
});

test("the shared-scene extension activates curvature and widened material without moving the legacy renderer path", () => {
  const visualGraph = graph();
  const legacy = applyMorphology(visualGraph, NEURAL, DEFAULT_CALIBRATION);
  const shared = applyMorphology(visualGraph, NEURAL, DEFAULT_CALIBRATION, SHARED_SCENE_MATERIAL_TARGET);
  assert.ok(legacy.edges.every((edge) => edge.curvaturePermille === 0));
  assert.ok(shared.edges.every((edge) => edge.curvaturePermille > 0));
  assert.ok(shared.edges.some((edge, index) => {
    const legacyEdge = legacy.edges[index];
    return legacyEdge !== undefined && (
      edge.widthPx !== legacyEdge.widthPx
      || edge.widthStartPermille !== legacyEdge.widthStartPermille
      || edge.widthEndPermille !== legacyEdge.widthEndPermille
    );
  }));
  assert.deepEqual(shared.nodeIds, legacy.nodeIds);
  assert.deepEqual(shared.edgeIds, legacy.edgeIds);
  assert.deepEqual(shared.incidence, legacy.incidence);
});

function requiredBinding(
  bindings: ReadonlyMap<string, ReturnType<typeof applyMorphology>>,
  id: string,
): ReturnType<typeof applyMorphology> {
  const binding = bindings.get(id);
  if (binding === undefined) {
    throw new TypeError("morphology binding is unavailable");
  }
  return binding;
}

function requiredNode(
  binding: ReturnType<typeof applyMorphology>,
  id: string,
): ReturnType<typeof applyMorphology>["nodes"][number] {
  const node = binding.nodes.find((candidate) => candidate.id === id);
  if (node === undefined) {
    throw new TypeError("morphology node is unavailable");
  }
  return node;
}
