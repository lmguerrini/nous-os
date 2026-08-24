import assert from "node:assert/strict";
import test from "node:test";
import {
  assertNoPassthrough,
  assertVisualGraphFieldRegister,
  createSemantic,
  semanticDigest,
} from "#engine/contract.ts";
import type { VisualGraph } from "#engine/contract.ts";

function makeGraph(): VisualGraph {
  return {
    schema_version: "nous-projection-ir/1",
    policy_id: "reliability",
    question: {
      valid_at: "2026-01-05T00:00:00+00:00",
      recorded_as_of: "2026-01-06T00:00:00+00:00",
    },
    nodes: [
      {
        id: "node:a",
        kind: "assertion",
        semantic: createSemantic({ text: "first" }),
        derived: { value: "supported", origin: "support-classifier" },
        visual: {
          role: "claim",
          anchor: { x: 1, y: 2, z: 0 },
          path: [{ x: 1, y: 2, z: 0 }],
          lod: { minimum: 0, maximum: 4 },
          label_priority: 10,
        },
      },
      {
        id: "node:b",
        kind: "source",
        semantic: createSemantic({ source_id: "source:b" }),
        derived: { value: 1, origin: "source-ranker" },
        visual: {
          role: "evidence",
          anchor: { x: 3, y: 4, z: 0 },
          path: [{ x: 3, y: 4, z: 0 }],
          lod: { minimum: 1, maximum: 5 },
          label_priority: 5,
        },
      },
    ],
    edges: [
      {
        id: "edge:a-b",
        kind: "cites",
        source: "node:a",
        target: "node:b",
        semantic: createSemantic({ span: "evidence" }),
        derived: { value: true, origin: "citation-resolver" },
        visual: {
          role: "citation",
          anchor: { x: 2, y: 3, z: 0 },
          path: [
            { x: 1, y: 2, z: 0 },
            { x: 3, y: 4, z: 0 },
          ],
          lod: { minimum: 0, maximum: 5 },
          label_priority: 1,
        },
      },
    ],
  };
}

test("semantic digest ignores node derived state", () => {
  const graph = makeGraph();
  const changed: VisualGraph = {
    ...graph,
    nodes: graph.nodes.map((node, index) => index === 0
      ? { ...node, derived: { value: "changed", origin: "new-computation" } }
      : node),
  };
  assert.equal(semanticDigest(changed), semanticDigest(graph));
  assert.equal(changed.schema_version, graph.schema_version);
  assert.equal(changed.policy_id, graph.policy_id);
  assert.equal(changed.question, graph.question);
  assert.equal(changed.edges, graph.edges);
});

test("semantic digest ignores edge visual state", () => {
  const graph = makeGraph();
  const changed: VisualGraph = {
    ...graph,
    edges: graph.edges.map((edge) => ({
      ...edge,
      visual: { ...edge.visual, label_priority: 99 },
    })),
  };
  assert.equal(semanticDigest(changed), semanticDigest(graph));
  assert.equal(changed.schema_version, graph.schema_version);
  assert.equal(changed.policy_id, graph.policy_id);
  assert.equal(changed.question, graph.question);
  assert.equal(changed.nodes, graph.nodes);
});

test("semantic digest changes with schema_version alone", () => {
  const graph = makeGraph();
  const changed: VisualGraph = { ...graph, schema_version: "nous-projection-ir/2" };
  assert.notEqual(semanticDigest(changed), semanticDigest(graph));
  assert.equal(changed.policy_id, graph.policy_id);
  assert.equal(changed.question, graph.question);
  assert.equal(changed.nodes, graph.nodes);
  assert.equal(changed.edges, graph.edges);
});

test("semantic digest changes with policy_id alone", () => {
  const graph = makeGraph();
  const changed: VisualGraph = { ...graph, policy_id: "discovery" };
  assert.notEqual(semanticDigest(changed), semanticDigest(graph));
  assert.equal(changed.schema_version, graph.schema_version);
  assert.equal(changed.question, graph.question);
  assert.equal(changed.nodes, graph.nodes);
  assert.equal(changed.edges, graph.edges);
});

test("semantic digest changes with question.valid_at alone", () => {
  const graph = makeGraph();
  const changed: VisualGraph = {
    ...graph,
    question: { ...graph.question, valid_at: "2026-01-07T00:00:00+00:00" },
  };
  assert.notEqual(semanticDigest(changed), semanticDigest(graph));
  assert.equal(changed.schema_version, graph.schema_version);
  assert.equal(changed.policy_id, graph.policy_id);
  assert.equal(changed.question.recorded_as_of, graph.question.recorded_as_of);
  assert.equal(changed.nodes, graph.nodes);
  assert.equal(changed.edges, graph.edges);
});

test("semantic digest changes with question.recorded_as_of alone", () => {
  const graph = makeGraph();
  const changed: VisualGraph = {
    ...graph,
    question: { ...graph.question, recorded_as_of: "2026-01-08T00:00:00+00:00" },
  };
  assert.notEqual(semanticDigest(changed), semanticDigest(graph));
  assert.equal(changed.schema_version, graph.schema_version);
  assert.equal(changed.policy_id, graph.policy_id);
  assert.equal(changed.question.valid_at, graph.question.valid_at);
  assert.equal(changed.nodes, graph.nodes);
  assert.equal(changed.edges, graph.edges);
});

test("semantic digest changes with node semantic content alone", () => {
  const graph = makeGraph();
  const changed: VisualGraph = {
    ...graph,
    nodes: graph.nodes.map((node, index) => index === 0
      ? { ...node, semantic: createSemantic({ text: "changed" }) }
      : node),
  };
  assert.notEqual(semanticDigest(changed), semanticDigest(graph));
  assert.equal(changed.schema_version, graph.schema_version);
  assert.equal(changed.policy_id, graph.policy_id);
  assert.equal(changed.question, graph.question);
  assert.equal(changed.edges, graph.edges);
  assert.equal(changed.nodes[1], graph.nodes[1]);
});

test("semantic digest changes with edge semantic content alone", () => {
  const graph = makeGraph();
  const changed: VisualGraph = {
    ...graph,
    edges: graph.edges.map((edge) => ({ ...edge, semantic: createSemantic({ span: "changed" }) })),
  };
  assert.notEqual(semanticDigest(changed), semanticDigest(graph));
  assert.equal(changed.schema_version, graph.schema_version);
  assert.equal(changed.policy_id, graph.policy_id);
  assert.equal(changed.question, graph.question);
  assert.equal(changed.nodes, graph.nodes);
});

test("input node and edge ordering does not affect the semantic digest", () => {
  const graph = makeGraph();
  const reordered: VisualGraph = {
    ...graph,
    nodes: [...graph.nodes].reverse(),
    edges: [...graph.edges].reverse(),
  };
  assert.equal(semanticDigest(reordered), semanticDigest(graph));
  assert.equal(reordered.schema_version, graph.schema_version);
  assert.equal(reordered.policy_id, graph.policy_id);
  assert.equal(reordered.question, graph.question);
});

test("the field register refuses extra fields", () => {
  const graph = makeGraph();
  const withExtra = { ...graph, unregistered: true };
  assert.throws(() => assertVisualGraphFieldRegister(withExtra), /pinned register/);
  assert.doesNotThrow(() => assertVisualGraphFieldRegister(graph));
});

test("the field register refuses missing fields", () => {
  const graph = makeGraph();
  const { policy_id: ignoredPolicyId, ...withoutPolicy } = graph;
  void ignoredPolicyId;
  assert.throws(() => assertVisualGraphFieldRegister(withoutPolicy), /pinned register/);
  assert.doesNotThrow(() => assertVisualGraphFieldRegister(graph));
});

test("the passthrough ban refuses a retained raw payload", () => {
  const graph = makeGraph();
  const rawPayload = { source: "raw" };
  const changed: VisualGraph = {
    ...graph,
    nodes: graph.nodes.map((node, index) => index === 0
      ? { ...node, derived: { ...node.derived, value: rawPayload } }
      : node),
  };
  assertVisualGraphFieldRegister(changed);
  assert.throws(() => assertNoPassthrough(changed, rawPayload, "a".repeat(64)), /raw source payload/);
  assert.doesNotThrow(() => assertNoPassthrough(graph, rawPayload, "a".repeat(64)));
});

test("the passthrough ban refuses a retained computed digest", () => {
  const graph = makeGraph();
  const computedDigest = "b".repeat(64);
  const changed: VisualGraph = {
    ...graph,
    edges: graph.edges.map((edge) => ({
      ...edge,
      derived: { ...edge.derived, value: computedDigest },
    })),
  };
  assertVisualGraphFieldRegister(changed);
  assert.throws(() => assertNoPassthrough(changed, { source: "raw" }, computedDigest), /computed digest/);
  assert.doesNotThrow(() => assertNoPassthrough(graph, { source: "raw" }, computedDigest));
});
