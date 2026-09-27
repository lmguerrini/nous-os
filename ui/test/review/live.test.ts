import test from "node:test";
import assert from "node:assert/strict";
import { LiveGraph } from "../../src/review/live-graph.ts";
import { placeDynamic } from "../../src/review/live-placement.ts";
import type { ReviewExport, ReviewNode, ReviewEdge } from "../../src/review/model.ts";

const base: ReviewExport = {
  schema: "nousos-graph-review-1", export_digest: "synthetic", notice: { it: "", en: "" },
  nodes: [{ id: "candidate:base", type: "candidate", label: "base", epistemic: "proposal" }],
  edges: [], layouts: { "2d": {}, "3d": {} },
};
const node = (id: string): ReviewNode => ({ id, type: "candidate", label: id, epistemic: "proposal",
  origin: "dynamic", origin_query: "synthetic", attested_by: "candidate.search" });
const edge = (target: string): ReviewEdge => ({ id: `supported_by:candidate:base->${target}`,
  type: "supported_by", source: "candidate:base", target, attested_by: "candidate.search",
  origin: "dynamic", weight: 1, evidence_ids: [] });

test("merge keeps curated records, caps unique additions, and replays steps", () => {
  const graph = new LiveGraph(base, 2);
  assert.equal(graph.add({ nodes: [node("candidate:a"), node("candidate:a")], edges: [edge("candidate:a")] }), true);
  assert.equal(graph.count, 1);
  assert.equal(graph.add({ nodes: [node("candidate:b")], edges: [] }), true);
  assert.throws(() => graph.add({ nodes: [node("candidate:c")], edges: [] }), /Limite/);
  assert.equal(graph.undo(), true);
  assert.equal(graph.count, 1);
  assert.equal(graph.redo(), true);
  assert.equal(graph.count, 2);
  assert.equal(graph.data.nodes[0], base.nodes[0]);
  assert.equal(graph.clear(), true);
  assert.equal(graph.count, 0);
});

test("dynamic provenance is required for every inserted node and edge", () => {
  const graph = new LiveGraph(base);
  assert.throws(() => graph.add({ nodes: [{ ...node("candidate:x"), attested_by: "" }], edges: [] }), /Provenienza/);
  assert.throws(() => graph.add({ nodes: [node("candidate:x")], edges: [{ ...edge("candidate:x"), origin: "" }] }),
    /Provenienza/);
});

test("placement preserves anchors and is stable across additions", () => {
  const anchors = new Map([["candidate:base", { x: 0.2, y: 0.1, z: 0 }]]);
  const first = placeDynamic(anchors, { nodes: [...base.nodes, node("candidate:a")], edges: [edge("candidate:a")] });
  const second = placeDynamic(anchors, { nodes: [...base.nodes, node("candidate:a"), node("candidate:b")],
    edges: [edge("candidate:a"), edge("candidate:b")] });
  assert.deepEqual(first.get("candidate:base"), anchors.get("candidate:base"));
  assert.deepEqual(first.get("candidate:a"), second.get("candidate:a"));
  assert.notDeepEqual(first.get("candidate:a"), anchors.get("candidate:base"));
});

test("placement scales with the supplied layout, so a new node never sits on its parent", () => {
  const anchors = new Map([
    ["candidate:base", { x: 0, y: 0, z: 0 }],
    ["candidate:far", { x: 3000, y: 2000, z: 0 }],
    ["candidate:mid", { x: 1500, y: 900, z: 0 }],
  ]);
  const placed = placeDynamic(anchors, {
    nodes: [node("candidate:base"), node("candidate:far"), node("candidate:mid"), node("candidate:a")],
    edges: [edge("candidate:a")],
  });
  const parent = anchors.get("candidate:base")!;
  const child = placed.get("candidate:a")!;
  const offset = Math.hypot(child.x - parent.x, child.y - parent.y);
  assert.ok(offset >= 3000 * 0.012, `offset ${offset} is at least 1.2% of the layout extent`);
  assert.ok(offset <= 3000 * 0.2, `offset ${offset} stays near its parent`);
});
