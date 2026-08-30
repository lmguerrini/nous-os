import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { toVisualGraph } from "#adapter/projection.ts";
import { readSemantic, semanticDigest } from "#engine/contract.ts";
import type { VisualGraph } from "#engine/contract.ts";
import {
  allTimeMembership,
  resolveTemporalMembership,
  resolveTemporalPlacements,
  temporalClassCounts,
} from "#engine/temporal.ts";
import type { TemporalMembership, TemporalPlacement } from "#engine/temporal.ts";

// This is the preregistered valid-time ground truth (TEMPORAL-FIXTURE-PREREGISTRATION.md),
// reproduced here as data so every test below is graded against it rather than
// against whatever the implementation happens to compute.
const GROUND_TRUTH = {
  T0: "2024-01-15T00:00:00+00:00",
  T1: "2024-03-01T00:00:00+00:00",
  T2: "2024-06-10T00:00:00+00:00",
  T3: "2024-09-22T00:00:00+00:00",
  T4: "2024-12-05T00:00:00+00:00",
  T5: "2025-02-14T00:00:00+00:00",
  T6: "2025-04-30T00:00:00+00:00",
  T7: "2025-06-18T00:00:00+00:00",
} as const;

const RECORDED_AT: Readonly<Record<string, string>> = {
  a1: "2026-03-08T00:00:00+00:00",
  a2: "2026-03-07T00:00:00+00:00",
  a3: "2026-03-06T00:00:00+00:00",
  a4: "2026-03-05T00:00:00+00:00",
  a5: "2026-03-04T00:00:00+00:00",
  a6: "2026-03-03T00:00:00+00:00",
  a7: "2026-03-02T00:00:00+00:00",
  a8: "2026-03-01T00:00:00+00:00",
};

// F83 (open, routed to the human): PREREGISTERED_CLASS_B/C below, and the {explicit: 8, derived:
// 13, unknown: 1} counts asserted further down, rest on one reading of the human ruling on
// ambiguous fixture elements. That reading is contested -- the ruling's own clarification implies
// counts of 8/7/7, not 8/13/1 -- and no decision has landed. These constants pin shipped behaviour
// so this suite keeps catching regressions; they are not a claim that this reading is settled.
const PREREGISTERED_CLASS_A = [
  "assertion:a1", "assertion:a2", "assertion:a3", "assertion:a4",
  "assertion:a5", "assertion:a6", "assertion:a7", "assertion:a8",
];

const PREREGISTERED_CLASS_B = [
  "subject:subj-alpha", "subject:subj-beta",
  "source:src-a1", "source:src-a2", "source:src-b1", "source:src-b2",
  "conflict:conflict-1",
  "bridge:bridge-a", "bridge:bridge-b", "bridge:bridge-cross",
  "cluster:cluster-alpha", "cluster:cluster-beta",
  "rejection:rejection-1",
];

const PREREGISTERED_CLASS_C = ["source:src-orphan"];

// Cumulative node-presence ground truth, one union per valid-time step. Built
// directly from the derivation rule applied by hand to the fixture topology,
// independently of the module under test.
const EXPECTED_MEMBERSHIP_STEPS: readonly (readonly string[])[] = [
  ["assertion:a1", "subject:subj-alpha", "source:src-a1", "bridge:bridge-a", "cluster:cluster-alpha"],
  ["assertion:a2", "source:src-a2", "conflict:conflict-1", "bridge:bridge-cross"],
  ["assertion:a3", "subject:subj-beta", "source:src-b1", "bridge:bridge-b", "cluster:cluster-beta", "rejection:rejection-1"],
  ["assertion:a4", "source:src-b2"],
  ["assertion:a5"],
  ["assertion:a6"],
  ["assertion:a7"],
  ["assertion:a8"],
];

function fixture(): unknown {
  return JSON.parse(readFileSync(
    join(process.cwd(), "..", "fixtures", "synthetic", "projection", "temporal", "temporal-genesis.json"),
    "utf8",
  ));
}

function graph(): VisualGraph {
  return toVisualGraph(fixture());
}

function expectedNodeIdsAtTemporal(instantKey: keyof typeof GROUND_TRUTH): Set<string> {
  const order: (keyof typeof GROUND_TRUTH)[] = ["T0", "T1", "T2", "T3", "T4", "T5", "T6", "T7"];
  const stepIndex = order.indexOf(instantKey);
  const ids = new Set<string>();
  for (let index = 0; index <= stepIndex; index += 1) {
    for (const id of EXPECTED_MEMBERSHIP_STEPS[index] ?? []) {
      ids.add(id);
    }
  }
  if (stepIndex >= order.indexOf("T6")) {
    ids.delete("assertion:a2");
  }
  return ids;
}

function sorted(ids: Iterable<string>): readonly string[] {
  return [...ids].sort();
}

test("the fixture carries exactly the preregistered element inventory", () => {
  const visualGraph = graph();
  assert.equal(visualGraph.nodes.length, 22);
  assert.equal(visualGraph.edges.length, 28);
  const byKind = new Map<string, number>();
  for (const node of visualGraph.nodes) {
    byKind.set(node.kind, (byKind.get(node.kind) ?? 0) + 1);
  }
  assert.deepEqual(Object.fromEntries(byKind), {
    subject: 2,
    source: 5,
    assertion: 8,
    cluster: 2,
    bridge: 3,
    conflict: 1,
    rejection: 1,
  });
});

test("recorded_at runs in strict reverse order of valid_from across a1..a8", () => {
  const raw = fixture() as { readonly nodes: readonly { readonly id: string; readonly attributes: Record<string, unknown> }[] };
  const assertions = raw.nodes.filter((node) => node.id.startsWith("assertion:"));
  assert.equal(assertions.length, 8);
  const byValidFrom = [...assertions].sort((left, right) =>
    String(left.attributes.valid_from).localeCompare(String(right.attributes.valid_from)));
  const byRecordedAtDescending = [...assertions].sort((left, right) =>
    String(right.attributes.recorded_at).localeCompare(String(left.attributes.recorded_at)));
  assert.deepEqual(byValidFrom.map((node) => node.id), byRecordedAtDescending.map((node) => node.id));
  for (const node of assertions) {
    const localId = String(node.attributes.assertion_id);
    assert.equal(node.attributes.recorded_at, RECORDED_AT[localId]);
  }
});

test("src-orphan is cited by no assertion and reached by no incidence chain", () => {
  const visualGraph = graph();
  const touchesOrphan = visualGraph.edges.some((edge) => edge.source === "source:src-orphan" || edge.target === "source:src-orphan");
  assert.equal(touchesOrphan, false);
});

test("measured class assignment matches the preregistered A/B/C partition exactly", () => {
  const visualGraph = graph();
  const placements = resolveTemporalPlacements(visualGraph);
  assert.equal(placements.size, 22);

  const actualA = sorted([...placements].filter(([, placement]) => placement.class === "explicit").map(([id]) => id));
  const actualB = sorted([...placements].filter(([, placement]) => placement.class === "derived").map(([id]) => id));
  const actualC = sorted([...placements].filter(([, placement]) => placement.class === "unknown").map(([id]) => id));

  assert.deepEqual(actualA, sorted(PREREGISTERED_CLASS_A));
  assert.deepEqual(actualB, sorted(PREREGISTERED_CLASS_B));
  assert.deepEqual(actualC, sorted(PREREGISTERED_CLASS_C));

  const counts = temporalClassCounts(placements);
  assert.deepEqual(counts, { explicit: 8, derived: 13, unknown: 1 });
});

test("every class-B placement names the governed elements that caused it", () => {
  const visualGraph = graph();
  const placements = resolveTemporalPlacements(visualGraph);
  const expectedCauses: Readonly<Record<string, { readonly through: string; readonly causes: readonly string[] }>> = {
    "subject:subj-alpha": { through: "about", causes: ["assertion:a1"] },
    "subject:subj-beta": { through: "about", causes: ["assertion:a3"] },
    "source:src-a1": { through: "cites", causes: ["assertion:a1"] },
    "source:src-a2": { through: "cites", causes: ["assertion:a2"] },
    "source:src-b1": { through: "cites", causes: ["assertion:a3"] },
    "source:src-b2": { through: "cites", causes: ["assertion:a4"] },
    "conflict:conflict-1": { through: "conflict_member", causes: ["assertion:a2"] },
    "bridge:bridge-a": { through: "bridge_side", causes: ["source:src-a1"] },
    "bridge:bridge-b": { through: "bridge_side", causes: ["source:src-b1"] },
    "bridge:bridge-cross": { through: "bridge_side", causes: ["source:src-a2"] },
    "cluster:cluster-alpha": { through: "in_cluster", causes: ["bridge:bridge-a"] },
    "cluster:cluster-beta": { through: "in_cluster", causes: ["bridge:bridge-b"] },
    "rejection:rejection-1": { through: "rejects", causes: ["cluster:cluster-beta"] },
  };
  assert.equal(Object.keys(expectedCauses).length, PREREGISTERED_CLASS_B.length);
  for (const id of PREREGISTERED_CLASS_B) {
    const placement = placements.get(id);
    assert.ok(placement !== undefined);
    assert.equal(placement.class, "derived");
    if (placement.class !== "derived") {
      continue;
    }
    const expected = expectedCauses[id];
    assert.ok(expected !== undefined, id);
    assert.equal(placement.through, expected.through, id);
    assert.deepEqual(placement.causes, expected.causes, id);
    assert.ok(visualGraph.nodes.some((node) => node.id === placement.causes[0]), `${id} causes a canonical id`);
  }
});

test("cluster placement resolves through exactly the preregistered two-hop chain and no further", () => {
  const visualGraph = graph();
  const placements = resolveTemporalPlacements(visualGraph);
  const cluster = placements.get("cluster:cluster-alpha");
  assert.ok(cluster !== undefined && cluster.class === "derived");
  if (cluster === undefined || cluster.class !== "derived") {
    return;
  }
  const bridge = placements.get(cluster.causes[0] as string);
  assert.ok(bridge !== undefined && bridge.class === "derived");
  if (bridge === undefined || bridge.class !== "derived") {
    return;
  }
  const source = placements.get(bridge.causes[0] as string);
  assert.ok(source !== undefined && source.class === "derived");
  if (source === undefined || source.class !== "derived") {
    return;
  }
  const assertion = placements.get(source.causes[0] as string);
  assert.ok(assertion !== undefined && assertion.class === "explicit");
});

test("no class-B or class-C node ever reports a governed valid_from", () => {
  const visualGraph = graph();
  const placements = resolveTemporalPlacements(visualGraph);
  for (const node of visualGraph.nodes) {
    if (node.kind === "assertion") {
      continue;
    }
    const placement = placements.get(node.id);
    assert.ok(placement !== undefined);
    assert.notEqual(placement.class, "explicit", node.id);
    const attributes = readSemantic(node.semantic) as Record<string, unknown>;
    assert.ok(!("valid_from" in attributes), `${node.id} attributes must not carry valid_from`);
  }
});

test("negative control: mislabelling a derived element as explicit is caught by the class check", () => {
  const visualGraph = graph();
  const placements = new Map(resolveTemporalPlacements(visualGraph));
  const corrupted = new Map(placements);
  corrupted.set("subject:subj-alpha", { class: "explicit", at: GROUND_TRUTH.T0, until: null });
  const nonAssertionIds = visualGraph.nodes.filter((node) => node.kind !== "assertion").map((node) => node.id);
  const realFailures = nonAssertionIds.filter((id) => placements.get(id)?.class === "explicit");
  const corruptedFailures = nonAssertionIds.filter((id) => corrupted.get(id)?.class === "explicit");
  assert.deepEqual(realFailures, []);
  assert.deepEqual(corruptedFailures, ["subject:subj-alpha"]);
});

test("src-orphan stays class C and absent from membership at every ground-truth instant and beyond", () => {
  const visualGraph = graph();
  const placements = resolveTemporalPlacements(visualGraph);
  assert.deepEqual(placements.get("source:src-orphan"), { class: "unknown" });

  const probeInstants = [
    "2000-01-01T00:00:00+00:00",
    ...Object.values(GROUND_TRUTH),
    "2999-01-01T00:00:00+00:00",
  ];
  for (const instant of probeInstants) {
    const membership = resolveTemporalMembership(visualGraph, placements, instant);
    assert.equal(membership.nodeIds.has("source:src-orphan"), false, instant);
  }
});

test("negative control: an orphan that was wrongly given a borrowed date would be visible, proving the check has teeth", () => {
  const visualGraph = graph();
  const placements = new Map(resolveTemporalPlacements(visualGraph));
  const corrupted = new Map(placements);
  corrupted.set("source:src-orphan", { class: "derived", through: "cites", at: GROUND_TRUTH.T0, causes: ["assertion:a1"] });
  const real = resolveTemporalMembership(visualGraph, placements, GROUND_TRUTH.T0);
  const wrong = resolveTemporalMembership(visualGraph, corrupted, GROUND_TRUTH.T0);
  assert.equal(real.nodeIds.has("source:src-orphan"), false);
  assert.equal(wrong.nodeIds.has("source:src-orphan"), true);
});

test("membership grows monotonically across T0..T5, a2 expires exactly at T6, and T7 adds a8", () => {
  const visualGraph = graph();
  const placements = resolveTemporalPlacements(visualGraph);
  const order: (keyof typeof GROUND_TRUTH)[] = ["T0", "T1", "T2", "T3", "T4", "T5", "T6", "T7"];
  const expectedCounts = [5, 9, 15, 17, 18, 19, 19, 20];
  for (const [index, key] of order.entries()) {
    const membership = resolveTemporalMembership(visualGraph, placements, GROUND_TRUTH[key]);
    const expected = expectedNodeIdsAtTemporal(key);
    assert.deepEqual(sorted(membership.nodeIds), sorted(expected), key);
    assert.equal(membership.nodeIds.size, expectedCounts[index], key);
  }
  const atT5 = resolveTemporalMembership(visualGraph, placements, GROUND_TRUTH.T5);
  const atT6 = resolveTemporalMembership(visualGraph, placements, GROUND_TRUTH.T6);
  assert.equal(atT5.nodeIds.has("assertion:a2"), true);
  assert.equal(atT6.nodeIds.has("assertion:a2"), false);
  assert.equal(atT6.nodeIds.has("assertion:a7"), true);
});

test("membership before T0 is empty and membership far past T7 still excludes a2 and src-orphan forever", () => {
  const visualGraph = graph();
  const placements = resolveTemporalPlacements(visualGraph);
  const before = resolveTemporalMembership(visualGraph, placements, "1999-01-01T00:00:00+00:00");
  assert.equal(before.nodeIds.size, 0);
  assert.equal(before.edgeIds.size, 0);

  const farFuture = resolveTemporalMembership(visualGraph, placements, "2999-01-01T00:00:00+00:00");
  assert.equal(farFuture.nodeIds.has("assertion:a2"), false);
  assert.equal(farFuture.nodeIds.has("source:src-orphan"), false);
  assert.equal(farFuture.nodeIds.size, 20);

  const allTime = allTimeMembership(visualGraph);
  assert.equal(allTime.nodeIds.size, 22);
  assert.notDeepEqual(sorted(farFuture.nodeIds), sorted(allTime.nodeIds));
});

test("negative control: an inclusive expiry boundary would wrongly keep a2 present exactly at T6", () => {
  const visualGraph = graph();
  const placements = resolveTemporalPlacements(visualGraph);
  const a2 = placements.get("assertion:a2");
  assert.ok(a2 !== undefined && a2.class === "explicit" && a2.until !== null);
  if (a2 === undefined || a2.class !== "explicit" || a2.until === null) {
    return;
  }
  const at = Date.parse(GROUND_TRUTH.T6);
  const until = Date.parse(a2.until);
  const correctlyExcluded = !(at < until);
  const buggyInclusiveWouldInclude = at <= until;
  assert.equal(correctlyExcluded, true);
  assert.equal(buggyInclusiveWouldInclude, true);
  const membership = resolveTemporalMembership(visualGraph, placements, GROUND_TRUTH.T6);
  assert.equal(membership.nodeIds.has("assertion:a2"), false);
});

test("playback never invents a node or relation: every id at every ground-truth instant is a canonical subset", () => {
  const visualGraph = graph();
  const placements = resolveTemporalPlacements(visualGraph);
  const canonicalNodeIds = new Set(visualGraph.nodes.map((node) => node.id));
  const canonicalEdgeIds = new Set(visualGraph.edges.map((edge) => edge.id));
  const edgeById = new Map(visualGraph.edges.map((edge) => [edge.id, edge]));

  function assertCanonicalSubset(membership: TemporalMembership): void {
    for (const id of membership.nodeIds) {
      if (!canonicalNodeIds.has(id)) {
        throw new TypeError(`membership invented node ${id}`);
      }
    }
    for (const id of membership.edgeIds) {
      if (!canonicalEdgeIds.has(id)) {
        throw new TypeError(`membership invented edge ${id}`);
      }
      const edge = edgeById.get(id);
      if (edge === undefined || !membership.nodeIds.has(edge.source) || !membership.nodeIds.has(edge.target)) {
        throw new TypeError(`membership includes edge ${id} with an absent endpoint`);
      }
    }
  }

  for (const instant of Object.values(GROUND_TRUTH)) {
    assertCanonicalSubset(resolveTemporalMembership(visualGraph, placements, instant));
  }
  assertCanonicalSubset(allTimeMembership(visualGraph));

  // Negative control: an invented id is rejected by the same check.
  const corrupted: TemporalMembership = {
    instant: GROUND_TRUTH.T0,
    nodeIds: new Set(["assertion:a1", "assertion:a999-invented"]),
    edgeIds: new Set(),
  };
  assert.throws(() => assertCanonicalSubset(corrupted), /invented node/);
});

test("temporal membership is invariant under node and edge array order", () => {
  const visualGraph = graph();
  const forwardPlacements = resolveTemporalPlacements(visualGraph);
  const reversedGraph: VisualGraph = { ...visualGraph, nodes: [...visualGraph.nodes].reverse(), edges: [...visualGraph.edges].reverse() };
  const reversedPlacements = resolveTemporalPlacements(reversedGraph);

  for (const instant of Object.values(GROUND_TRUTH)) {
    const forward = resolveTemporalMembership(visualGraph, forwardPlacements, instant);
    const reversed = resolveTemporalMembership(reversedGraph, reversedPlacements, instant);
    assert.deepEqual(sorted(forward.nodeIds), sorted(reversed.nodeIds), instant);
    assert.deepEqual(sorted(forward.edgeIds), sorted(reversed.edgeIds), instant);
  }
});

test("negative control: a first-match-in-array-order deriver (unlike min-of-all) disagrees with itself under reversal", () => {
  const visualGraph = graph();

  // A deliberately order-dependent stand-in for `derivedPlacement`: instead of
  // taking the minimum over every incident neighbour, it takes whichever
  // neighbour the edge array happens to list first. This is the shape of bug
  // the order-invariance property above exists to catch.
  function firstMatchSourceDate(edges: VisualGraph["edges"], validFromByAssertionId: ReadonlyMap<string, string>): string | undefined {
    for (const edge of edges) {
      if (edge.kind !== "cites" || edge.target !== "source:src-a1") {
        continue;
      }
      const validFrom = validFromByAssertionId.get(edge.source);
      if (validFrom !== undefined) {
        return validFrom;
      }
    }
    return undefined;
  }

  const validFromByAssertionId = new Map(
    visualGraph.nodes
      .filter((node) => node.kind === "assertion")
      .map((node) => [node.id, (readSemantic(node.semantic) as Record<string, unknown>).valid_from as string]),
  );

  const forward = firstMatchSourceDate(visualGraph.edges, validFromByAssertionId);
  const reversed = firstMatchSourceDate([...visualGraph.edges].reverse(), validFromByAssertionId);
  assert.notEqual(forward, reversed);

  // The real deriver is unaffected by the same reversal.
  const placements = resolveTemporalPlacements(visualGraph);
  const reversedPlacements = resolveTemporalPlacements({ ...visualGraph, edges: [...visualGraph.edges].reverse() });
  assert.deepEqual(placements.get("source:src-a1"), reversedPlacements.get("source:src-a1"));
});

test("negative control: Valid Time replaced by Recorded Time reverses which assertion appears first", () => {
  const visualGraph = graph();
  const placements = resolveTemporalPlacements(visualGraph);
  const membershipAtT0 = resolveTemporalMembership(visualGraph, placements, GROUND_TRUTH.T0);
  const explicitPresentAtT0 = [...membershipAtT0.nodeIds].filter((id) => id.startsWith("assertion:"));
  assert.deepEqual(explicitPresentAtT0, ["assertion:a1"]);

  // A deliberately wrong resolver that reads recorded_at where valid_from
  // belongs. Local to this test; it never touches production code.
  const wrongPlacements = new Map<string, TemporalPlacement>();
  for (const node of visualGraph.nodes) {
    if (node.kind !== "assertion") {
      continue;
    }
    const attributes = readSemantic(node.semantic) as Record<string, unknown>;
    wrongPlacements.set(node.id, { class: "explicit", at: attributes.recorded_at as string, until: null });
  }
  const earliestUnderRecordedAt = [...wrongPlacements.entries()].sort(([, left], [, right]) => {
    const leftAt = left.class === "explicit" ? left.at : "";
    const rightAt = right.class === "explicit" ? right.at : "";
    return leftAt.localeCompare(rightAt);
  })[0];
  assert.ok(earliestUnderRecordedAt !== undefined);
  assert.equal(earliestUnderRecordedAt[0], "assertion:a8");
  assert.notEqual(earliestUnderRecordedAt[0], explicitPresentAtT0[0]);
});

test("resting state is the unconditional all-time union, byte-identical to a fresh parse of the fixture", () => {
  const visualGraph = graph();
  const freshParse = toVisualGraph(fixture());
  const allTime = allTimeMembership(visualGraph);
  assert.deepEqual(sorted(allTime.nodeIds), sorted(freshParse.nodes.map((node) => node.id)));
  assert.deepEqual(sorted(allTime.edgeIds), sorted(freshParse.edges.map((edge) => edge.id)));
  assert.equal(allTime.nodeIds.has("source:src-orphan"), true, "all-time union includes the temporally unknown element");
  assert.equal(allTime.nodeIds.has("assertion:a2"), true, "all-time union includes an assertion that has since expired");
});

test("resolving temporal state at any number of instants never mutates the supplied graph", () => {
  const visualGraph = graph();
  const digestBefore = semanticDigest(visualGraph);
  const nodesRefBefore = visualGraph.nodes;
  const edgesRefBefore = visualGraph.edges;

  const placements = resolveTemporalPlacements(visualGraph);
  for (const instant of [...Object.values(GROUND_TRUTH), "1999-01-01T00:00:00+00:00", "2999-01-01T00:00:00+00:00"]) {
    resolveTemporalMembership(visualGraph, placements, instant);
  }
  allTimeMembership(visualGraph);

  assert.equal(semanticDigest(visualGraph), digestBefore);
  assert.equal(visualGraph.nodes, nodesRefBefore);
  assert.equal(visualGraph.edges, edgesRefBefore);
});

test("negative control: a mutating pass on the graph is caught by the digest check that guards exit", () => {
  const visualGraph = graph();
  const digestBefore = semanticDigest(visualGraph);

  // A deliberately mutating stand-in: pushes a duplicate of the first node
  // directly onto the live array, simulating a playback step that leaks a
  // filtered copy back into canonical state.
  (visualGraph.nodes as unknown[]).push(visualGraph.nodes[0]);

  assert.notEqual(semanticDigest(visualGraph), digestBefore);
});
