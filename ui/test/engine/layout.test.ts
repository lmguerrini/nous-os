import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { toVisualGraph } from "#adapter/projection.ts";
import type { Coordinates, VisualGraph } from "#engine/contract.ts";
import { layoutAnchors, sharedAnchors } from "#engine/layout.ts";

/** This reads a checked-in projection and does not manufacture graph structure. */
function graph(name: string): VisualGraph {
  return toVisualGraph(JSON.parse(readFileSync(join(process.cwd(), "..", "fixtures", "synthetic", "projection", name), "utf8")) as unknown);
}

/** This maps anchors into a comparison record and does not reorder the source graph. */
function recordOf(anchors: ReadonlyMap<string, Coordinates>): Record<string, Coordinates> {
  return Object.fromEntries([...anchors.entries()].sort(([left], [right]) => left.localeCompare(right)));
}

test("layout anchors are bit-identical across runs and input order", () => {
  const discovery = graph("discovery-at-question.json");
  const first = layoutAnchors(discovery);
  const second = layoutAnchors(discovery);
  const shuffled = { ...discovery, nodes: [...discovery.nodes].reverse() };
  const shuffledAnchors = layoutAnchors(shuffled);
  assert.ok(first.size > 0);
  assert.equal(first.size, discovery.nodes.length);
  assert.equal(second.size, discovery.nodes.length);
  assert.equal(shuffledAnchors.size, discovery.nodes.length);
  assert.deepEqual(recordOf(first), recordOf(second));
  assert.deepEqual(recordOf(first), recordOf(shuffledAnchors));
  for (const anchor of first.values()) {
    assert.equal(anchor.z, 0);
  }
  assert.equal([...first.values()].length, discovery.nodes.length);
});

test("Reliability reads the complete shared Discovery anchor set", () => {
  const discovery = graph("discovery-at-question.json");
  const reliability = graph("reliability-at-question.json");
  const discoveryAnchors = layoutAnchors(discovery);
  const shared = sharedAnchors(discovery, reliability);
  assert.ok(shared.size > 0);
  assert.equal(shared.size, reliability.nodes.length);
  assert.equal([...shared.entries()].length, reliability.nodes.length);
  for (const node of reliability.nodes) {
    const sharedAnchor = shared.get(node.id);
    const discoveryAnchor = discoveryAnchors.get(node.id);
    assert.ok(sharedAnchor !== undefined);
    assert.ok(discoveryAnchor !== undefined);
    assert.deepEqual(sharedAnchor, discoveryAnchor);
  }
  assert.equal(reliability.nodes.length, shared.size);
});

test("a mutable-counter control cannot meet the layout determinism contract", () => {
  const discovery = graph("discovery-at-question.json");
  let counter = 0;
  const counterAnchors = (): Record<string, Coordinates> => Object.fromEntries(discovery.nodes.map((node) => {
    counter += 1;
    return [node.id, { x: counter, y: counter, z: 0 }];
  }));
  const first = counterAnchors();
  const second = counterAnchors();
  assert.equal(Object.keys(first).length, discovery.nodes.length);
  assert.equal(Object.keys(second).length, discovery.nodes.length);
  assert.notDeepEqual(first, second);
});

test("anchors serialise identically however the node array is ordered", () => {
  // The values were never order-dependent -- unitHash reads only the id. What was
  // order-dependent was a Map's iteration order, so anything serialising the
  // anchors got different bytes from an identical computation. VisualState has to
  // round-trip byte-identically, so this pins the ordering rather than the values.
  const forward = graph("discovery-all-time.json");
  const reversed = { ...forward, nodes: [...forward.nodes].reverse() };
  const serialise = (anchors: ReadonlyMap<string, unknown>): string =>
    JSON.stringify(Object.fromEntries(anchors));

  assert.ok(forward.nodes.length > 1, "a one-node graph cannot detect an ordering defect");
  assert.equal(serialise(layoutAnchors(reversed)), serialise(layoutAnchors(forward)));
});
