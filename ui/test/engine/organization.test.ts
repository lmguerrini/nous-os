import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { toVisualGraph } from "#adapter/projection.ts";
import { DEFAULT_CALIBRATION } from "#engine/calibration.ts";
import type { EngineGraph } from "#engine/contract.ts";
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

/** This reads any checked-in projection fixture by its relative path segments and does not manufacture graph structure. */
function fixtureGraph(relativePath: readonly string[]) {
  return toVisualGraph(JSON.parse(readFileSync(
    join(process.cwd(), "..", "fixtures", "synthetic", "projection", ...relativePath),
    "utf8",
  )) as unknown);
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

test("Indra reserves disjoint discs before placing members and non-members, on the plain fixture and both community-scale Indra fixtures", () => {
  // discovery-at-question.json alone never exercised this: its four discs
  // never came close enough to overlap under the old N-linear disc radius or
  // the corrected sqrt(member count) one, so a passing suite here proved
  // nothing about cross-community disc separation. indra-community-windows.json
  // is the fixture on which discs actually overlapped (auditor-measured: 6
  // pairwise overlaps, 8 nodes geometrically inside a window they were not a
  // governed member of) before aggregateDiscs' region placement was corrected
  // to keep every community's own discs clear of every other community's.
  for (const relativePath of [
    ["discovery-at-question.json"],
    ["indra", "indra-community-windows.json"],
    ["indra", "indra-portal-windows.json"],
  ]) {
    const label = relativePath.join("/");
    const visualGraph = fixtureGraph(relativePath);
    const anchors = layoutAnchors(visualGraph, DEFAULT_CALIBRATION);
    const result = indraOrganization(visualGraph, DEFAULT_CALIBRATION, anchors);
    const members = new Set(result.windows.flatMap((window) => window.members));
    assert.ok(members.size > 0, `${label} needs aggregate members to prove containment`);
    assert.ok(result.windows.length > 1, `${label} needs more than one aggregate to prove cross-window disjointness`);
    for (const window of result.windows) {
      for (const member of window.members) {
        const anchor = anchors.get(member);
        assert.ok(anchor !== undefined, label);
        assert.ok(distance(anchor, window.center) <= window.radius, `${label} ${member} escaped ${window.id}`);
      }
    }
    for (const node of visualGraph.nodes.filter((node) => !members.has(node.id))) {
      const anchor = anchors.get(node.id);
      assert.ok(anchor !== undefined, label);
      for (const window of result.windows) {
        assert.ok(distance(anchor, window.center) > window.radius, `${label} ${node.id} entered ${window.id}`);
      }
    }
    for (const [index, window] of result.windows.entries()) {
      for (const other of result.windows.slice(index + 1)) {
        assert.ok(distance(window.center, other.center) > window.radius + other.radius, `${label} ${window.id} overlaps ${other.id}`);
      }
    }
    assertIndraOrganization(visualGraph, result);
  }
});

test("assertIndraOrganization's geometric overlap check actually fires on a fabricated overlap", () => {
  const visualGraph = fixtureGraph(["indra", "indra-community-windows.json"]);
  const result = indraOrganization(visualGraph, DEFAULT_CALIBRATION);
  assert.ok(result.windows.length > 1, "the fixture needs more than one window to fabricate an overlap between");
  const [first, second] = result.windows;
  assert.ok(first !== undefined && second !== undefined);
  const collided = {
    ...result,
    windows: result.windows.map((window) => window.id === second.id ? { ...window, center: first.center } : window),
  };
  assert.throws(() => assertIndraOrganization(visualGraph, collided), /overlap/);
  // Restored (unmutated) result still passes.
  assertIndraOrganization(visualGraph, result);
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

test("assertIndraLayout's member-escaped-window throw actually fires on a member moved outside its window", () => {
  const visualGraph = fixtureGraph(["indra", "indra-community-windows.json"]);
  const layout = indraLayout(visualGraph, DEFAULT_CALIBRATION);
  const targetWindow = layout.windows.find((window) => window.members.length > 0);
  assert.ok(targetWindow !== undefined, "the fixture needs a non-empty window to escape a member from");
  const member = targetWindow.members[0];
  assert.ok(member !== undefined);
  const farAway = { x: targetWindow.center.x + (targetWindow.radius * 100), y: targetWindow.center.y, z: 0 };
  const escaped = {
    ...layout,
    nodeAnchors: new Map(layout.nodeAnchors).set(member, farAway),
  };
  assert.throws(() => assertIndraLayout(visualGraph, escaped), /escaped its window/);
  // Restored (unmutated) layout still passes.
  assertIndraLayout(visualGraph, layout);
});

test("assertIndraLayout's window-overlap throw actually fires on two windows moved to the same place", () => {
  const visualGraph = fixtureGraph(["indra", "indra-community-windows.json"]);
  const layout = indraLayout(visualGraph, DEFAULT_CALIBRATION);
  assert.ok(layout.windows.length > 1, "the fixture needs more than one window to collide");
  const [first, second] = layout.windows;
  assert.ok(first !== undefined && second !== undefined);
  // Translate the second window and every one of its own members rigidly onto
  // the first window's center, so the two discs collide without any member
  // escaping its own (equally translated) window -- isolating the overlap
  // check from the membership-escape check above it.
  const translation = { x: first.center.x - second.center.x, y: first.center.y - second.center.y };
  const nodeAnchors = new Map(layout.nodeAnchors);
  for (const memberId of second.members) {
    const anchor = requiredNodeAnchor(layout.nodeAnchors, memberId);
    nodeAnchors.set(memberId, { x: anchor.x + translation.x, y: anchor.y + translation.y, z: anchor.z });
  }
  const collided = {
    ...layout,
    nodeAnchors,
    windows: layout.windows.map((window) => window.id === second.id ? { ...window, center: first.center } : window),
  };
  assert.throws(() => assertIndraLayout(visualGraph, collided), /windows overlap/);
  // Restored (unmutated) layout still passes.
  assertIndraLayout(visualGraph, layout);
});

test("assertIndraLayout's satellite-entered-window throw actually fires on a satellite moved inside a window", () => {
  const visualGraph = fixtureGraph(["indra", "indra-community-windows.json"]);
  const layout = indraLayout(visualGraph, DEFAULT_CALIBRATION);
  const window = layout.windows[0];
  assert.ok(window !== undefined);
  const windowMemberIds = new Set(layout.windows.flatMap((candidate) => candidate.members));
  const windowIds = new Set(layout.windows.map((candidate) => candidate.id));
  const satellite = layout.nodeIds.find((id) => !windowMemberIds.has(id) && !windowIds.has(id));
  assert.ok(satellite !== undefined, "the fixture needs a satellite to move inside a window");
  const invaded = {
    ...layout,
    nodeAnchors: new Map(layout.nodeAnchors).set(satellite, window.center),
  };
  assert.throws(() => assertIndraLayout(visualGraph, invaded), /satellite entered/);
  // Restored (unmutated) layout still passes.
  assertIndraLayout(visualGraph, layout);
});

test("the real satellite settle keeps a satellite outside a window even when its spring pull targets the window's interior", () => {
  // This is not a hand-mutated violation like the three throws above: it
  // exercises the real settleSatellitePositions path (indraLayout, unmutated)
  // against a graph and calibration built so a satellite's spring pull
  // genuinely targets a point inside the one window that exists, not just a
  // hand-edited result object. At a very small idealEdgeLengthPx the spring
  // target from the satellite's only neighbor (a window member) shrinks
  // toward that member's own position, deep inside the window, while
  // windowPaddingPx does not shrink with it -- confirmed by measurement
  // (with clearWindows's call temporarily deleted, this exact graph and
  // calibration place the satellite 0.79 world units from the window
  // center against a 14.24-unit radius, i.e. solidly inside). clearWindows
  // is the only thing in settleSatellitePositions that pushes a candidate
  // back outside a window's rim each iteration; deleting that call
  // previously left the full suite green because no governed fixture's
  // satellite actually needed it. This graph and calibration are built so
  // one does.
  const graph: EngineGraph = {
    nodes: [
      { id: "cluster:solo-window", kind: "cluster", visual: { role: "cluster", label_priority: 0 } },
      { id: "assertion:only-member", kind: "assertion", visual: { role: "assertion", label_priority: 0 } },
      { id: "assertion:pulled-satellite", kind: "assertion", visual: { role: "assertion", label_priority: 0 } },
    ],
    edges: [
      { id: "edge:membership", kind: "in_cluster", source: "assertion:only-member", target: "cluster:solo-window", visual: { role: "edge", label_priority: 0 } },
      { id: "edge:pull", kind: "cites", source: "assertion:pulled-satellite", target: "assertion:only-member", visual: { role: "edge", label_priority: 0 } },
    ],
  };
  const tightSpringCalibration = {
    ...DEFAULT_CALIBRATION,
    layout: { ...DEFAULT_CALIBRATION.layout, idealEdgeLengthPx: 1 },
  };
  const layout = indraLayout(graph, tightSpringCalibration);
  const window = layout.windows.find((candidate) => candidate.id === "cluster:solo-window");
  assert.ok(window !== undefined);
  const satelliteAnchor = requiredNodeAnchor(layout.nodeAnchors, "assertion:pulled-satellite");
  const satelliteDistance = Math.hypot(satelliteAnchor.x - window.center.x, satelliteAnchor.y - window.center.y);
  assert.ok(satelliteDistance > window.radius, `expected the pulled satellite to clear the window rim, received distance ${satelliteDistance} against radius ${window.radius}`);
  assertIndraLayout(graph, layout);
});

function requiredNodeAnchor(anchors: ReadonlyMap<string, { readonly x: number; readonly y: number; readonly z: number }>, id: string) {
  const anchor = anchors.get(id);
  if (anchor === undefined) {
    throw new TypeError(`missing node anchor ${id}`);
  }
  return anchor;
}
