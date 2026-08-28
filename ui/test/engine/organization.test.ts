import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { toVisualGraph } from "#adapter/projection.ts";
import { DEFAULT_CALIBRATION } from "#engine/calibration.ts";
import { aggregateMemberships, layoutAnchors } from "#engine/layout.ts";
import {
  INDRA,
  assertIndraLayout,
  assertIndraOrganization,
  flatOrganization,
  indraLayout,
  indraOrganization,
  rejectionBoundsDisjointFromWindows,
} from "#engine/organization.ts";

/** This reads one checked-in graph and does not infer membership from semantic payloads. */
function graph() {
  return toVisualGraph(JSON.parse(readFileSync(join(process.cwd(), "..", "fixtures", "synthetic", "projection", "discovery-at-question.json"), "utf8")) as unknown);
}

test("Indra windows are exactly the fixture's real aggregates and memberships", () => {
  const visualGraph = graph();
  const clusters = visualGraph.nodes.filter((node) => node.kind === "cluster");
  const conflicts = visualGraph.nodes.filter((node) => node.kind === "conflict");
  assert.ok(clusters.length > 0);
  assert.ok(conflicts.length > 0);
  const result = indraOrganization(visualGraph, DEFAULT_CALIBRATION);
  assert.equal(result.organization, INDRA);
  assert.equal(result.windows.length, clusters.length + conflicts.length);
  assert.equal(result.nodeIds.length, visualGraph.nodes.length);
  assert.equal(result.edgeIds.length, visualGraph.edges.length);
  assertIndraOrganization(visualGraph, result);
  const flat = flatOrganization(visualGraph);
  assert.equal(flat.windows.length, 0);
  assert.equal(flat.nodeIds.length, visualGraph.nodes.length);
  assert.equal(flat.edgeIds.length, visualGraph.edges.length);
});

test("Indra reserves disjoint discs before placing members and non-members", () => {
  const visualGraph = graph();
  const anchors = layoutAnchors(visualGraph, DEFAULT_CALIBRATION);
  const result = indraOrganization(visualGraph, DEFAULT_CALIBRATION, anchors);
  const members = new Set(result.windows.flatMap((window) => window.members));
  assert.ok(members.size > 0, "the fixture needs aggregate members to prove containment");
  for (const window of result.windows) {
    for (const member of window.members) {
      const anchor = anchors.get(member);
      assert.ok(anchor !== undefined);
      assert.ok(distance(anchor, window.center) <= window.radius, `${member} escaped ${window.id}`);
    }
  }
  for (const node of visualGraph.nodes.filter((node) => !members.has(node.id))) {
    const anchor = anchors.get(node.id);
    assert.ok(anchor !== undefined);
    for (const window of result.windows) {
      assert.ok(distance(anchor, window.center) > window.radius, `${node.id} entered ${window.id}`);
    }
  }
  for (const [index, window] of result.windows.entries()) {
    for (const other of result.windows.slice(index + 1)) {
      assert.ok(distance(window.center, other.center) > window.radius + other.radius, `${window.id} overlaps ${other.id}`);
    }
  }
});

test("a rejection inside an aggregate window fails the geometric predicate", () => {
  const result = indraOrganization(graph(), DEFAULT_CALIBRATION);
  const window = result.windows[0];
  assert.ok(window !== undefined);
  const inside = [{
    minimumX: window.bounds.minimumX,
    minimumY: window.bounds.minimumY,
    maximumX: window.bounds.minimumX,
    maximumY: window.bounds.minimumY,
  }];
  assert.equal(inside.length, 1);
  assert.equal(result.windows.length > 0, true);
  assert.equal(rejectionBoundsDisjointFromWindows(inside, result.windows), false);
});

test("a window made from rejects targets fails exact cluster membership", () => {
  const visualGraph = graph();
  const result = indraOrganization(visualGraph, DEFAULT_CALIBRATION);
  const reject = visualGraph.edges.find((edge) => edge.kind === "rejects");
  assert.ok(reject !== undefined);
  const affected = result.windows.find((window) => window.id === reject.target);
  assert.ok(affected !== undefined);
  const badWindows = result.windows.map((window) => window.id === reject.target ? { ...window, members: [reject.target] } : window);
  const bad = { ...result, windows: badWindows };
  assert.equal(bad.windows.length, result.windows.length);
  assert.throws(() => assertIndraOrganization(visualGraph, bad), /membership/);
});

test("the predicate accepts the shape the organization result actually exposes", () => {
  // Wiring `result.rejectionBounds` into the predicate is the obvious call, and it
  // used to answer "not disjoint" for geometry that is disjoint, because the result
  // exposes {id, bounds} while the predicate read bare bounds. A false violation is
  // the dangerous direction here: it reports invented containment that does not exist.
  const result = indraOrganization(graph(), DEFAULT_CALIBRATION);
  assert.ok(result.rejectionBounds.length > 0, "no rejection means this proves nothing");
  assert.ok(result.windows.length > 0, "no window means this proves nothing");

  const wrapped = rejectionBoundsDisjointFromWindows(result.rejectionBounds, result.windows);
  const bare = rejectionBoundsDisjointFromWindows(
    result.rejectionBounds.map((entry) => entry.bounds),
    result.windows,
  );
  assert.equal(wrapped, bare);
  assert.equal(wrapped, true);
});

function distance(left: { readonly x: number; readonly y: number }, right: { readonly x: number; readonly y: number }): number {
  return Math.hypot(left.x - right.x, left.y - right.y);
}

test("Indra's independent re-layout resolves the same node and relation id sets as Flat, and every window's membership is exactly governed, on both fixtures", () => {
  for (const relativePath of [
    ["discovery-at-question.json"],
    ["indra", "indra-community-windows.json"],
  ]) {
    const visualGraph = toVisualGraph(JSON.parse(readFileSync(
      join(process.cwd(), "..", "fixtures", "synthetic", "projection", ...relativePath),
      "utf8",
    )) as unknown);
    const label = relativePath.join("/");
    const flat = flatOrganization(visualGraph);
    const relayout = indraLayout(visualGraph, DEFAULT_CALIBRATION);
    const governedNodeIds = visualGraph.nodes.map((node) => node.id).sort();
    const governedEdgeIds = visualGraph.edges.map((edge) => edge.id).sort();
    assert.deepEqual([...relayout.nodeIds].sort(), governedNodeIds, label);
    assert.deepEqual([...relayout.edgeIds].sort(), governedEdgeIds, label);
    assert.deepEqual([...flat.nodeIds].sort(), governedNodeIds, label);
    assert.deepEqual([...flat.edgeIds].sort(), governedEdgeIds, label);
    assertIndraLayout(visualGraph, relayout);

    const expectedMemberships = aggregateMemberships(visualGraph);
    assert.ok(relayout.windows.length > 0, `${label} needs real aggregates to prove this`);
    for (const window of relayout.windows) {
      const expected = expectedMemberships.get(window.id);
      assert.ok(expected !== undefined, label);
      assert.deepEqual([...window.members].sort(), [...expected].sort(), `${label} ${window.id}`);
    }

    // Demonstrate the membership check actually fails on a fabricated member, then restore it.
    const targetWindow = relayout.windows.find((window) => window.members.length > 0);
    assert.ok(targetWindow !== undefined, `${label} needs a non-empty window to fabricate a member into`);
    const fabricated = {
      ...relayout,
      windows: relayout.windows.map((window) => window.id === targetWindow.id
        ? { ...window, members: [...window.members, "fabricated-member-not-real"] }
        : window),
    };
    assert.throws(() => assertIndraLayout(visualGraph, fabricated), /membership/);
    assertIndraLayout(visualGraph, relayout);
  }
});
