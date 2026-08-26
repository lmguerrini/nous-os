import assert from "node:assert/strict";
import test from "node:test";
import {
  assertNoPassthrough,
  assertEngineAccessTrace,
  assertVisualGraphFieldRegister,
  createEngineGraphView,
  createRenderedStateCarrier,
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
        rendered: createRenderedStateCarrier([{ enumType: "TemporalDisposition", member: "established" }]),
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
        rendered: createRenderedStateCarrier(null),
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
        rendered: createRenderedStateCarrier(null),
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

test("the closed RENDERED carrier refuses free text, identifiers, attributes, and unbounded values at construction", () => {
  const accepted = [
    { enumType: "TemporalDisposition", member: "established" },
    { enumType: "TemporalDisposition", member: "excluded" },
    { enumType: "TemporalDisposition", member: "undetermined" },
    { enumType: "BridgeDisposition", member: "accepted" },
    { enumType: "BridgeDisposition", member: "rejected" },
    { enumType: "BridgeDisposition", member: "undetermined" },
    { enumType: "EpistemicClass", member: "explicit" },
    { enumType: "EpistemicClass", member: "derived" },
    { enumType: "EpistemicClass", member: "speculative" },
  ];
  assert.equal(accepted.length, 9);
  for (const state of accepted) {
    assert.doesNotThrow(() => createRenderedStateCarrier([state]));
  }
  const rejected: readonly unknown[] = [
    "established",
    [{ enumType: "TemporalDisposition", member: "invented" }],
    [{ enumType: "TemporalDisposition", member: "established", identifier: "assertion:one" }],
    [{ enumType: "TemporalDisposition", member: "established", attributes: { temporal: "established" } }],
    [
      { enumType: "TemporalDisposition", member: "established" },
      { enumType: "BridgeDisposition", member: "accepted" },
      { enumType: "EpistemicClass", member: "explicit" },
    ],
  ];
  assert.equal(rejected.length, 5);
  for (const value of rejected) {
    assert.throws(() => createRenderedStateCarrier(value), /rendered state carrier|pinned RENDERED member|fields do not match/);
  }
});

test("the structural refusal control rejects a field outside the allow-list and fails open when that refusal is removed", () => {
  const view = createEngineGraphView(makeGraph());
  const node = view.graph.nodes[0] as (typeof view.graph.nodes)[number] & { readonly semantic?: unknown } | undefined;
  assert.ok(node !== undefined);
  void node.semantic;
  const mustRefuse = (action: () => void): void => {
    let failure: unknown;
    try {
      action();
    } catch (error) {
      failure = error;
    }
    assert.ok(failure instanceof Error, "structural refusal control accepted an outside field");
    assert.match(failure.message, /outside the structural allow-list: node\.semantic/);
  };
  mustRefuse(() => assertEngineAccessTrace(view.trace));
  assert.throws(
    () => mustRefuse(() => undefined),
    /structural refusal control accepted an outside field/,
  );
});

test("derived origins are non-null named sources and every nested register refuses unknown keys", () => {
  const graph = makeGraph();
  const node = graph.nodes[0];
  const edge = graph.edges[0];
  assert.ok(node !== undefined && edge !== undefined);
  const pathPoint = node.visual.path[0];
  assert.ok(pathPoint !== undefined);
  const cases: readonly { readonly name: string; readonly value: unknown; readonly rule: RegExp }[] = [
    { name: "graph", value: { ...graph, unknown: true }, rule: /graph fields do not match the pinned register/ },
    { name: "question", value: { ...graph, question: { ...graph.question, unknown: true } }, rule: /question fields do not match the pinned register/ },
    { name: "node", value: { ...graph, nodes: [{ ...node, unknown: true }, ...graph.nodes.slice(1)] }, rule: /nodes\[0\] fields do not match the pinned register/ },
    { name: "edge", value: { ...graph, edges: [{ ...edge, unknown: true }, ...graph.edges.slice(1)] }, rule: /edges\[0\] fields do not match the pinned register/ },
    { name: "node rendered", value: { ...graph, nodes: [{ ...node, rendered: [{ enumType: "TemporalDisposition", member: "invented" }] }, ...graph.nodes.slice(1)] }, rule: /nodes\[0\]\.rendered.*pinned RENDERED member/ },
    { name: "node derived", value: { ...graph, nodes: [{ ...node, derived: { ...node.derived, unknown: true } }, ...graph.nodes.slice(1)] }, rule: /nodes\[0\]\.derived fields do not match the pinned register/ },
    { name: "inherited derived key", value: { ...graph, nodes: [{ ...node, derived: Object.assign(Object.create({ unknown: true }), node.derived) }, ...graph.nodes.slice(1)] }, rule: /nodes\[0\]\.derived must be a plain object/ },
    { name: "edge derived", value: { ...graph, edges: [{ ...edge, derived: { ...edge.derived, unknown: true } }, ...graph.edges.slice(1)] }, rule: /edges\[0\]\.derived fields do not match the pinned register/ },
    { name: "visual", value: { ...graph, nodes: [{ ...node, visual: { ...node.visual, unknown: true } }, ...graph.nodes.slice(1)] }, rule: /nodes\[0\]\.visual fields do not match the pinned register/ },
    { name: "anchor", value: { ...graph, nodes: [{ ...node, visual: { ...node.visual, anchor: { ...node.visual.anchor, unknown: true } } }, ...graph.nodes.slice(1)] }, rule: /nodes\[0\]\.visual\.anchor fields do not match the pinned register/ },
    { name: "path coordinate", value: { ...graph, nodes: [{ ...node, visual: { ...node.visual, path: [{ ...pathPoint, unknown: true }] } }, ...graph.nodes.slice(1)] }, rule: /nodes\[0\]\.visual\.path\[0\] fields do not match the pinned register/ },
    { name: "lod", value: { ...graph, nodes: [{ ...node, visual: { ...node.visual, lod: { ...node.visual.lod, unknown: true } } }, ...graph.nodes.slice(1)] }, rule: /nodes\[0\]\.visual\.lod fields do not match the pinned register/ },
    { name: "node null origin", value: { ...graph, nodes: [{ ...node, derived: { ...node.derived, origin: null } }, ...graph.nodes.slice(1)] }, rule: /nodes\[0\]\.derived\.origin must be a non-empty string/ },
    { name: "node absent origin", value: { ...graph, nodes: [{ ...node, derived: { value: node.derived.value } }, ...graph.nodes.slice(1)] }, rule: /nodes\[0\]\.derived fields do not match the pinned register/ },
    { name: "edge null origin", value: { ...graph, edges: [{ ...edge, derived: { ...edge.derived, origin: null } }] }, rule: /edges\[0\]\.derived\.origin must be a non-empty string/ },
    { name: "edge absent origin", value: { ...graph, edges: [{ ...edge, derived: { value: edge.derived.value } }] }, rule: /edges\[0\]\.derived fields do not match the pinned register/ },
    { name: "blank origin", value: { ...graph, nodes: [{ ...node, derived: { ...node.derived, origin: "" } }, ...graph.nodes.slice(1)] }, rule: /nodes\[0\]\.derived\.origin must be a non-empty string/ },
  ];
  assert.equal(cases.length, 17);
  for (const invalid of cases) {
    assert.throws(() => assertVisualGraphFieldRegister(invalid.value), invalid.rule, invalid.name);
  }
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
