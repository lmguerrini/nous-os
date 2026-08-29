import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { toVisualGraph } from "#adapter/projection.ts";
import type { CalibrationProfile } from "#engine/calibration.ts";
import { DEFAULT_AGGREGATE_LAYOUT_CALIBRATION, DEFAULT_CALIBRATION } from "#engine/calibration.ts";
import { detectCommunities } from "#engine/community.ts";
import type { Coordinates, EngineGraph, VisualGraph } from "#engine/contract.ts";
import { aggregateDiscs, aggregateMemberships, layoutAnchors, sharedAnchors } from "#engine/layout.ts";
import { assertIndraLayout, indraLayout } from "#engine/organization.ts";

const FIXTURE_NAMES = [
  "discovery-all-time.json",
  "discovery-at-question.json",
  "reliability-all-time.json",
  "reliability-at-question.json",
  "substrate-all-time.json",
] as const;

// This independent Python-derived mapping keeps layout measurements from using
// the detector under test to decide which edges are bridges.
const PINNED_DISCOVERY_PARTITION: Readonly<Record<string, string>> = {
  "assertion:asr_3N8REEPQF5FW301DG544P5B6PD": "assertion:asr_3N8REEPQF5FW301DG544P5B6PD",
  "assertion:asr_5TWK1P6Y46QA77Z57NEGKRKWWY": "assertion:asr_5TWK1P6Y46QA77Z57NEGKRKWWY",
  "assertion:asr_ESSGDR0NQDZKN3S4MW5GHA6BRM": "assertion:asr_3N8REEPQF5FW301DG544P5B6PD",
  "assertion:asr_KGR9S6MBNCNN4M883X8T9DXN5N": "assertion:asr_KGR9S6MBNCNN4M883X8T9DXN5N",
  "assertion:asr_SMTB0CSZJQ358QNW8833KCCV38": "assertion:asr_3N8REEPQF5FW301DG544P5B6PD",
  "assertion:asr_SRMYMBJ820XS1T5A7KCFDS5QP5": "assertion:asr_5TWK1P6Y46QA77Z57NEGKRKWWY",
  "bridge:asr_0NXJWD0YYT3PTBZKKYSGCE38H6": "bridge:asr_0NXJWD0YYT3PTBZKKYSGCE38H6",
  "bridge:asr_J936VNJ2V7Z8933ATMX7MJ4KE1": "bridge:asr_0NXJWD0YYT3PTBZKKYSGCE38H6",
  "bridge:asr_JM31PFESFYAKASHC0PCJ5R73QY": "bridge:asr_0NXJWD0YYT3PTBZKKYSGCE38H6",
  "cluster:lonely-synthetic-cluster": "cluster:lonely-synthetic-cluster",
  "cluster:shared-synthetic-cluster": "bridge:asr_0NXJWD0YYT3PTBZKKYSGCE38H6",
  "conflict:741067d7abefe872c53e3950ff88c05dd102d161d2c04d511981ab4d436e1ce1": "assertion:asr_5TWK1P6Y46QA77Z57NEGKRKWWY",
  "conflict:a6f8572024a765f3464d02c4ef6b8be64f7877e6afc401c1241f1ce644eed384": "assertion:asr_3N8REEPQF5FW301DG544P5B6PD",
  "rejection:57ef957416a9cc319ed1579c1e30e450d67a5e5b9a83b88532e7939f1c70d376": "cluster:lonely-synthetic-cluster",
  "source:src_CBB03C02CN7MV5ZE3JF757P7Y6": "assertion:asr_KGR9S6MBNCNN4M883X8T9DXN5N",
  "source:src_FMA6T2MD80ZTS2JWZNXWSKY00X": "assertion:asr_5TWK1P6Y46QA77Z57NEGKRKWWY",
  "source:src_RCNA2APXSA299MAKG6W6KQ2D41": "assertion:asr_3N8REEPQF5FW301DG544P5B6PD",
  "source:src_VMZQH8736EREJCH28C4Q2RPHA1": "bridge:asr_0NXJWD0YYT3PTBZKKYSGCE38H6",
  "source:src_W01T4SYMNAXJA855RC7SPFEFVV": "bridge:asr_0NXJWD0YYT3PTBZKKYSGCE38H6",
  "subject:conflict-subject": "assertion:asr_3N8REEPQF5FW301DG544P5B6PD",
  "subject:orphan-subject": "assertion:asr_KGR9S6MBNCNN4M883X8T9DXN5N",
  "subject:uncertain-subject": "assertion:asr_5TWK1P6Y46QA77Z57NEGKRKWWY",
};

const PINNED_DISCOVERY_MEMBERSHIPS: ReadonlyMap<string, string> = new Map(Object.entries(PINNED_DISCOVERY_PARTITION));

/** This reads a checked-in projection and does not manufacture graph structure. */
function graph(name: string): VisualGraph {
  return toVisualGraph(JSON.parse(readFileSync(join(process.cwd(), "..", "fixtures", "synthetic", "projection", name), "utf8")) as unknown);
}

/** This reads a checked-in projection by relative path segments and does not manufacture graph structure. */
function fixtureGraph(relativePath: readonly string[]): VisualGraph {
  return toVisualGraph(JSON.parse(readFileSync(
    join(process.cwd(), "..", "fixtures", "synthetic", "projection", ...relativePath),
    "utf8",
  )) as unknown);
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

test("layout anchors occupy a plane rather than a correlated diagonal", () => {
  const anchors = [...layoutAnchors(graph("discovery-at-question.json")).values()];
  assert.ok(anchors.length > 1, "a one-node graph cannot measure correlation");
  const correlation = pearson(anchors.map((anchor) => anchor.x), anchors.map((anchor) => anchor.y));
  assert.ok(Math.abs(correlation) < 0.5, `expected |Pearson r| < 0.5, received ${Math.abs(correlation)}`);
});

test("jitter keeps every non-member anchor outside aggregate discs and every fixture below the correlation bound", () => {
  assert.equal(FIXTURE_NAMES.length, 5);
  for (const name of FIXTURE_NAMES) {
    const visualGraph = graph(name);
    const anchors = layoutAnchors(visualGraph);
    const members = new Set([...aggregateMemberships(visualGraph).values()].flat());
    const discs = aggregateDiscs(visualGraph);
    for (const node of visualGraph.nodes) {
      if (members.has(node.id)) {
        continue;
      }
      const anchor = anchors.get(node.id);
      assert.ok(anchor !== undefined, `${name} is missing anchor ${node.id}`);
      if (anchor === undefined) {
        continue;
      }
      for (const disc of discs) {
        const distance = Math.hypot(anchor.x - disc.center.x, anchor.y - disc.center.y);
        assert.ok(distance >= disc.radius, `${name} placed non-member ${node.id} inside aggregate ${disc.id}`);
      }
    }
    const values = [...anchors.values()];
    assert.ok(values.length > 1, `${name} needs multiple anchors for correlation`);
    const correlation = pearson(values.map((anchor) => anchor.x), values.map((anchor) => anchor.y));
    assert.ok(Math.abs(correlation) < 0.5, `${name} expected |Pearson r| < 0.5, received ${Math.abs(correlation)}`);
  }
});

test("layout anchors stay within the calibrated aspect-ratio tolerance", () => {
  const anchors = [...layoutAnchors(graph("discovery-at-question.json")).values()];
  const bounds = {
    width: Math.max(...anchors.map((anchor) => anchor.x)) - Math.min(...anchors.map((anchor) => anchor.x)),
    height: Math.max(...anchors.map((anchor) => anchor.y)) - Math.min(...anchors.map((anchor) => anchor.y)),
  };
  const aspectRatio = bounds.width / bounds.height;
  const target = DEFAULT_AGGREGATE_LAYOUT_CALIBRATION.aspectRatioTargetPermille / 1000;
  const tolerance = DEFAULT_AGGREGATE_LAYOUT_CALIBRATION.aspectRatioTolerancePermille / 1000;
  assert.ok(Math.abs(aspectRatio - target) <= tolerance, `expected aspect ratio ${aspectRatio} within ${tolerance} of ${target}`);
  assert.ok(Math.abs(5.6 - target) > tolerance, "the measured 5.6:1 smear must not meet the configured tolerance");
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

test("anchor cache misses when edge topology changes on the same graph object", () => {
  const cachedGraph = structuralGraph(["a", "b", "c"], [["a", "b"], ["b", "c"]]);
  const emptyTopology = structuralGraph(["a", "b", "c"], []);

  sharedAnchors(cachedGraph, cachedGraph);
  replaceEdges(cachedGraph, []);

  assert.deepEqual(recordOf(layoutAnchors(cachedGraph)), recordOf(layoutAnchors(emptyTopology)));
});

test("community layout bounds measured bridge-to-intra medians on both sides", () => {
  const discovery = graph("discovery-all-time.json");
  const anchors = layoutAnchors(discovery);
  const lengths = discovery.edges.reduce((result, edge) => {
    const source = requiredAnchor(anchors, edge.source);
    const target = requiredAnchor(anchors, edge.target);
    const sourceCommunity = requiredPinnedCommunity(edge.source);
    const targetCommunity = requiredPinnedCommunity(edge.target);
    const length = Math.hypot(source.x - target.x, source.y - target.y);
    return sourceCommunity === targetCommunity
      ? { intra: [...result.intra, length], bridge: result.bridge }
      : { intra: result.intra, bridge: [...result.bridge, length] };
  }, { intra: [] as number[], bridge: [] as number[] });
  const intraMedian = median(lengths.intra);
  const bridgeMedian = median(lengths.bridge);
  const ratio = bridgeMedian / intraMedian;

  assertFinitePositive(intraMedian, "intra-community median");
  assertFinitePositive(bridgeMedian, "bridge median");
  assert.ok(Number.isFinite(ratio), `expected finite bridge/intra ratio, received ${ratio}`);
  const minimum = DEFAULT_CALIBRATION.layout.minimumBridgeToIntraMedianRatioPermille / 1000;
  const maximum = DEFAULT_CALIBRATION.layout.maximumBridgeToIntraMedianRatioPermille / 1000;
  assert.ok(ratio >= minimum, `expected median bridge/intra ratio >= ${minimum}, received ${ratio} (${bridgeMedian}/${intraMedian})`);
  assert.ok(ratio <= maximum, `expected median bridge/intra ratio <= ${maximum}, received ${ratio} (${bridgeMedian}/${intraMedian})`);
});

// A prior version of this test asserted hasVariedWithinCommunityDensity(...) > 0.35
// against the shipped layout and justified the 0.35 floor (down from 0.5) with a
// claim that a uniform grid's CV "would sit near zero." That claim was never
// measured. It is false: a plain uniform grid in id order measures 0.448 here,
// and a single equally-spaced ring -- a layout with no community structure at
// all -- measures 0.488, both *above* the shipped layout's 0.419. No floor can
// accept the shipped layout while rejecting either control, since both score
// higher than what they were supposed to be rejecting. The metric rewards
// disorder over community-aware placement and cannot support a pass/fail claim
// about "varied density," so it is retired as a gate here, in favour of a
// direct assertion of the placement property it was standing in for (below).
test("the within-community nearest-neighbour CV cannot separate the shipped layout from structure-free controls that have no community structure at all", () => {
  const anchors = layoutAnchors(graph("discovery-all-time.json"));
  const ids = [...PINNED_DISCOVERY_MEMBERSHIPS.keys()].sort(compareText);

  const shippedCv = withinCommunityNearestCoefficientOfVariation(anchors, PINNED_DISCOVERY_MEMBERSHIPS);
  const uniformGridIdOrderCv = withinCommunityNearestCoefficientOfVariation(uniformGridIdOrder(ids), PINNED_DISCOVERY_MEMBERSHIPS);
  const uniformGridCommunityBlockedCv = withinCommunityNearestCoefficientOfVariation(
    uniformGridCommunityBlocked(ids, PINNED_DISCOVERY_MEMBERSHIPS),
    PINNED_DISCOVERY_MEMBERSHIPS,
  );
  const singleRingCv = withinCommunityNearestCoefficientOfVariation(singleEquallySpacedRing(ids), PINNED_DISCOVERY_MEMBERSHIPS);

  console.log(`within-community CV controls: ${JSON.stringify({ shippedCv, uniformGridIdOrderCv, uniformGridCommunityBlockedCv, singleRingCv })}`);

  // Regression-pin every number this test's own reasoning depends on, so no
  // comment near this test can ever again state a figure nothing measures.
  assert.ok(Math.abs(shippedCv - 0.419) < 0.001, `shipped layout CV drifted from the measured baseline: ${shippedCv}`);
  assert.ok(Math.abs(uniformGridIdOrderCv - 0.448) < 0.001, `uniform-grid (id order) CV drifted from the measured baseline: ${uniformGridIdOrderCv}`);
  assert.equal(uniformGridCommunityBlockedCv, 0, "a grid uniform within every community block should measure exactly zero spread");
  assert.ok(Math.abs(singleRingCv - 0.488) < 0.001, `single-ring CV drifted from the measured baseline: ${singleRingCv}`);

  // The two controls that carry no community structure both outscore the
  // shipped layout, which is the fact that makes this metric unusable as a
  // pass/fail floor.
  assert.ok(shippedCv < uniformGridIdOrderCv, "expected the shipped layout to score below a structure-free uniform grid it should have beaten");
  assert.ok(shippedCv < singleRingCv, "expected the shipped layout to score below a structure-free single ring it should have beaten");
});

test("aggregate members scatter through their disc's interior at varying distances from its center, not only along its rim", () => {
  // This is the placement property the retired CV floor was standing in for:
  // memberAnchor scatters a disc's members by both angle and radius (radial
  // hash times available radius), so real members should span a meaningful
  // range of distances from their disc's center rather than sitting on a
  // single ring. This is measured against layoutAnchors' actual FINAL
  // output -- memberAnchor's radial placement AFTER settleAnchors and
  // enforceMinimumScreenPairwiseSeparation have both run over it -- not
  // memberAnchor's raw output directly, since layoutAnchors is the only
  // public surface that exposes a member's final position. That gap is
  // real: collapsing memberAnchor's own radial hash onto one fixed
  // mid-disc ring (distance = 0.5 * availableRadius for every member)
  // leaves this test green, because the downstream separation pass alone
  // reintroduces enough spread to clear the 0.2 floor. Only a more severe
  // collapse -- every member forced onto the disc's outer rim -- turns it
  // red, which is what keeps this a real, non-vacuous check of the FINAL
  // rendered placement property (what a viewer actually sees), even though
  // it cannot isolate memberAnchor's own contribution to it. Measured on
  // the community-scale Indra portal fixture, whose aggregates carry 8-15
  // real members each -- enough for the range to be a signal, not noise.
  const visualGraph = fixtureGraph(["indra", "indra-portal-windows.json"]);
  const anchors = layoutAnchors(visualGraph);
  const discs = aggregateDiscs(visualGraph);
  const multiMemberDiscs = discs.filter((disc) => disc.members.length >= 4);
  assert.ok(multiMemberDiscs.length > 0, "the fixture needs a multi-member aggregate to measure interior scatter");
  for (const disc of multiMemberDiscs) {
    const distances = disc.members.map((id) => {
      const anchor = requiredAnchor(anchors, id);
      return Math.hypot(anchor.x - disc.center.x, anchor.y - disc.center.y);
    });
    const range = Math.max(...distances) - Math.min(...distances);
    const availableRadius = disc.radius - DEFAULT_CALIBRATION.aggregate.windowPaddingPx;
    assert.ok(availableRadius > 0, `${disc.id} needs interior room for members to scatter into`);
    assert.ok(range / availableRadius > 0.2, `${disc.id} expected member distances from center to span more than a fifth of the disc's interior, received range ${range} over available radius ${availableRadius}`);
  }
});

test("fixed-count settling is bit-identical across runs", () => {
  const discovery = graph("discovery-at-question.json");
  const first = layoutAnchors(discovery);
  const second = layoutAnchors(discovery);

  assert.deepEqual(recordOf(first), recordOf(second));
});

test("fixed-count settling ignores node array order", () => {
  const discovery = graph("discovery-at-question.json");
  const reversed = { ...discovery, nodes: [...discovery.nodes].reverse() };
  const forwardAnchors = layoutAnchors(discovery);
  const reversedAnchors = layoutAnchors(reversed);

  assert.deepEqual(recordOf(forwardAnchors), recordOf(reversedAnchors));
});

test("fixed-count settling consumes the configured iteration count", () => {
  const discovery = graph("discovery-at-question.json");
  const oneIteration = {
    ...DEFAULT_CALIBRATION,
    layout: { ...DEFAULT_CALIBRATION.layout, iterations: 1 },
  };
  const twoIterations = {
    ...DEFAULT_CALIBRATION,
    layout: { ...DEFAULT_CALIBRATION.layout, iterations: 2 },
  };

  assert.notDeepEqual(recordOf(layoutAnchors(discovery, oneIteration)), recordOf(layoutAnchors(discovery, twoIterations)));
});

test("every fixture maintains the governed minimum pairwise anchor separation at the 1200x800 reference frame, not every viewport", () => {
  const floor = governedMinimumPairwiseAnchorSeparationPx(DEFAULT_CALIBRATION);
  assert.equal(FIXTURE_NAMES.length, 5);
  for (const name of FIXTURE_NAMES) {
    const anchors = layoutAnchors(graph(name));
    const minimum = minimumPairwiseAnchorSeparationInCssPixels(anchors, DEFAULT_CALIBRATION);
    assert.ok(hasMinimumPairwiseAnchorSeparation(anchors, floor, DEFAULT_CALIBRATION), `${name} expected reference-frame CSS-pixel pairwise anchor separation >= ${floor}, received ${minimum}; this does not guarantee the same CSS-pixel separation at every viewport size`);
  }
});

test("the reference-frame separation predicate does not claim the retired 60-world-unit floor or viewport independence", () => {
  const anchors = new Map<string, Coordinates>([
    ["extent:minimum", { x: 0, y: 0, z: 0 }],
    ["closest", { x: 10, y: 0, z: 0 }],
    ["extent:maximum", { x: 100, y: 100, z: 0 }],
  ]);
  const worldSeparation = minimumPairwiseAnchorSeparation(anchors);
  const referenceFrameCssSeparation = minimumPairwiseAnchorSeparationInCssPixels(anchors, DEFAULT_CALIBRATION);
  const referenceFrameAccepted = hasMinimumPairwiseAnchorSeparation(
    anchors,
    governedMinimumPairwiseAnchorSeparationPx(DEFAULT_CALIBRATION),
    DEFAULT_CALIBRATION,
  );
  const retiredWorldFloorAccepted = worldSeparation >= 60;

  console.log(`reference-frame separation limitation control: ${JSON.stringify({ worldSeparation, referenceFrameCssSeparation, retiredWorldFloorAccepted, referenceFrameAccepted })}`);
  assert.deepEqual(
    { worldSeparation, referenceFrameCssSeparation, retiredWorldFloorAccepted, referenceFrameAccepted },
    { worldSeparation: 10, referenceFrameCssSeparation: 80, retiredWorldFloorAccepted: false, referenceFrameAccepted: true },
  );
});

test("every fixture occupies the governed minimum fraction of its frame with community regions", () => {
  const minimum = DEFAULT_CALIBRATION.layout.minimumCommunityRegionFrameUtilisationPermille / 1000;
  assert.equal(FIXTURE_NAMES.length, 5);
  for (const name of FIXTURE_NAMES) {
    const visualGraph = graph(name);
    const utilisation = communityRegionFrameUtilisation(layoutAnchors(visualGraph), detectCommunities(visualGraph));
    assert.ok(hasMinimumCommunityRegionFrameUtilisation(utilisation, minimum), `${name} expected community-region frame utilisation >= ${minimum}, received ${utilisation}`);
  }
});

test("the corner-spanning community counterexample fails occupied-cell frame utilisation", () => {
  const anchors = new Map<string, Coordinates>([
    ["corner:bottom-left", { x: 0, y: 0, z: 0 }],
    ["corner:bottom-right", { x: 100, y: 0, z: 0 }],
    ["corner:top-left", { x: 0, y: 100, z: 0 }],
    ["corner:top-right", { x: 100, y: 100, z: 0 }],
  ]);
  const memberships = new Map<string, string>([...anchors.keys()].map((id) => [id, "corner-spanning"]));
  const minimum = DEFAULT_CALIBRATION.layout.minimumCommunityRegionFrameUtilisationPermille / 1000;
  const utilisation = communityRegionFrameUtilisation(anchors, memberships);
  const accepted = hasMinimumCommunityRegionFrameUtilisation(utilisation, minimum);

  console.log(`corner-spanning community utilisation control: ${JSON.stringify({ utilisation, minimum, accepted })}`);
  assert.deepEqual({ utilisation, minimum, accepted }, { utilisation: 4 / 49, minimum: 0.1, accepted: false });
});

test("the coincident-anchor counterexample fails the property-level layout predicates", () => {
  const anchors = new Map<string, Coordinates>([
    ...Array.from({ length: 19 }, (_, index) => [`coincident:${index}`, { x: 0, y: 0, z: 0 }] as const),
    ["spread:left", { x: -0.75, y: 0, z: 0 }],
    ["spread:right", { x: 0.75, y: 0, z: 0 }],
    ["spread:top", { x: 0, y: 1, z: 0 }],
  ]);
  const memberships = new Map<string, string>([
    ...Array.from({ length: 19 }, (_, index) => [`coincident:${index}`, "coincident"] as const),
    ["spread:left", "left"],
    ["spread:right", "right"],
    ["spread:top", "top"],
  ]);
  const predicates = {
    minimumPairwiseSeparation: hasMinimumPairwiseAnchorSeparation(anchors, governedMinimumPairwiseAnchorSeparationPx(DEFAULT_CALIBRATION), DEFAULT_CALIBRATION),
    finitePositiveMedians: hasFinitePositiveMedians(median([0, 0]), median([1, 1])),
    withinCommunityDensity: hasVariedWithinCommunityDensity(anchors, memberships),
  };

  console.log(`coincident-anchor predicates: ${JSON.stringify(predicates)}`);
  assert.deepEqual(predicates, {
    minimumPairwiseSeparation: false,
    finitePositiveMedians: false,
    withinCommunityDensity: false,
  });
});

test("every fixture keeps non-members outside every aggregate disc after settling", () => {
  for (const name of FIXTURE_NAMES) {
    const visualGraph = graph(name);
    const anchors = layoutAnchors(visualGraph);
    const members = new Set([...aggregateMemberships(visualGraph).values()].flat());
    for (const disc of aggregateDiscs(visualGraph)) {
      for (const node of visualGraph.nodes) {
        if (members.has(node.id)) {
          continue;
        }
        const anchor = requiredAnchor(anchors, node.id);
        const distance = Math.hypot(anchor.x - disc.center.x, anchor.y - disc.center.y);
        assert.ok(distance >= disc.radius, `${name} placed non-member ${node.id} inside aggregate ${disc.id}`);
      }
    }
  }
});

// This targets organization.ts's assertIndraLayout, whose own tests live in
// test/engine/organization.test.ts, which is outside this delegation's write scope; this file already
// imports the layout surface assertIndraLayout is built on, so the control lives here instead.
test("assertIndraLayout resolves a governed graph whose aggregate nodes are not in sorted-id order", () => {
  // Every shipped fixture happens to have its cluster/conflict nodes already in ascending id order
  // inside the graph's own node array. assertIndraLayout used to compare indraLayout's own
  // alphabetically sorted window ids against aggregate ids read straight out of graph.nodes in
  // whatever order the graph put them, so that accident of fixture data -- not anything the
  // assertion actually checked -- was what kept it from throwing on valid input. This reverses just
  // the aggregate nodes' relative order, leaving every other node's array position untouched, to
  // prove the assertion no longer depends on that accident.
  const visualGraph = fixtureGraph(["indra", "indra-community-windows.json"]);
  const aggregateSlots = visualGraph.nodes
    .map((node, index) => ({ node, index }))
    .filter(({ node }) => node.kind === "cluster" || node.kind === "conflict");
  assert.ok(aggregateSlots.length > 1, "the fixture needs more than one aggregate to prove order independence");
  const originalAggregateOrder = aggregateSlots.map(({ node }) => node.id);
  assert.deepEqual(
    originalAggregateOrder,
    [...originalAggregateOrder].sort(compareText),
    "the fixture's own aggregate order must already be sorted, or reversing it proves nothing about the accident being relied on",
  );
  const reversedAggregateNodes = [...aggregateSlots].reverse().map(({ node }) => node);
  const reorderedNodes = visualGraph.nodes.map((node, index) => {
    const slot = aggregateSlots.findIndex((entry) => entry.index === index);
    return slot === -1 ? node : (reversedAggregateNodes[slot] ?? node);
  });
  assert.notDeepEqual(reorderedNodes.map((node) => node.id), visualGraph.nodes.map((node) => node.id));
  assert.deepEqual([...reorderedNodes.map((node) => node.id)].sort(), [...visualGraph.nodes.map((node) => node.id)].sort());
  const reorderedGraph = { ...visualGraph, nodes: reorderedNodes };

  const relayout = indraLayout(reorderedGraph, DEFAULT_CALIBRATION);
  assert.doesNotThrow(
    () => assertIndraLayout(reorderedGraph, relayout),
    "a governed graph whose aggregates are not in sorted-id order must still resolve",
  );
});

function median(values: readonly number[]): number {
  const ordered = [...values].sort((left, right) => left - right);
  assert.ok(ordered.length > 0, "a median requires at least one value");
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 0
    ? ((ordered[middle - 1] ?? 0) + (ordered[middle] ?? 0)) / 2
    : (ordered[middle] ?? 0);
}

function assertFinitePositive(value: number, name: string): void {
  assert.ok(Number.isFinite(value) && value > 0, `expected finite positive ${name}, received ${value}`);
}

function hasFinitePositiveMedians(intraMedian: number, bridgeMedian: number): boolean {
  return Number.isFinite(intraMedian) && intraMedian > 0 && Number.isFinite(bridgeMedian) && bridgeMedian > 0;
}

function governedMinimumPairwiseAnchorSeparationPx(calibration: Pick<CalibrationProfile, "layout" | "salience">): number {
  return Math.max(
    calibration.layout.minimumPairwiseAnchorSeparationPx,
    calibration.salience.maxNodeSizePx + calibration.layout.minimumPairwiseAnchorSeparationGapPx,
  );
}

function hasMinimumPairwiseAnchorSeparation(
  anchors: ReadonlyMap<string, Coordinates>,
  floor: number,
  calibration: Pick<CalibrationProfile, "layout">,
): boolean {
  return minimumPairwiseAnchorSeparationInCssPixels(anchors, calibration) >= floor;
}

function minimumPairwiseAnchorSeparation(anchors: ReadonlyMap<string, Coordinates>): number {
  const entries = [...anchors.entries()].sort(([left], [right]) => compareText(left, right));
  let minimum = Number.POSITIVE_INFINITY;
  for (const [leftIndex, [, left]] of entries.entries()) {
    for (const [, right] of entries.slice(leftIndex + 1)) {
      minimum = Math.min(minimum, Math.hypot(left.x - right.x, left.y - right.y));
    }
  }
  return minimum;
}

function minimumPairwiseAnchorSeparationInCssPixels(
  anchors: ReadonlyMap<string, Coordinates>,
  calibration: Pick<CalibrationProfile, "layout">,
): number {
  return minimumPairwiseAnchorSeparation(anchors) * referenceFitScale(anchors, calibration);
}

function referenceFitScale(
  anchors: ReadonlyMap<string, Coordinates>,
  calibration: Pick<CalibrationProfile, "layout">,
): number {
  const values = [...anchors.values()];
  const width = Math.max(...values.map((anchor) => anchor.x)) - Math.min(...values.map((anchor) => anchor.x));
  const height = Math.max(...values.map((anchor) => anchor.y)) - Math.min(...values.map((anchor) => anchor.y));
  const horizontalScale = width === 0 ? Number.POSITIVE_INFINITY : calibration.layout.referenceFrameWidthPx / width;
  const verticalScale = height === 0 ? Number.POSITIVE_INFINITY : calibration.layout.referenceFrameHeightPx / height;
  return Math.min(horizontalScale, verticalScale);
}

function communityRegionFrameUtilisation(
  anchors: ReadonlyMap<string, Coordinates>,
  memberships: ReadonlyMap<string, string>,
): number {
  const values = [...anchors.values()];
  const width = Math.max(...values.map((anchor) => anchor.x)) - Math.min(...values.map((anchor) => anchor.x));
  const height = Math.max(...values.map((anchor) => anchor.y)) - Math.min(...values.map((anchor) => anchor.y));
  if (width === 0 || height === 0) {
    return 0;
  }
  const minimumX = Math.min(...values.map((anchor) => anchor.x));
  const minimumY = Math.min(...values.map((anchor) => anchor.y));
  const occupiedCells = new Set<string>();
  for (const [id, anchor] of [...anchors.entries()].sort(([left], [right]) => compareText(left, right))) {
    requiredCommunity(memberships, id);
    const column = Math.min(6, Math.floor(((anchor.x - minimumX) / width) * 7));
    const row = Math.min(6, Math.floor(((anchor.y - minimumY) / height) * 7));
    occupiedCells.add(`${column}:${row}`);
  }
  return occupiedCells.size / 49;
}

function hasMinimumCommunityRegionFrameUtilisation(utilisation: number, minimum: number): boolean {
  return utilisation >= minimum;
}

function hasVariedWithinCommunityDensity(
  anchors: ReadonlyMap<string, Coordinates>,
  memberships: ReadonlyMap<string, string>,
): boolean {
  const coefficientOfVariation = withinCommunityNearestCoefficientOfVariation(anchors, memberships);
  return Number.isFinite(coefficientOfVariation) && coefficientOfVariation > 0.35;
}

function withinCommunityNearestCoefficientOfVariation(
  anchors: ReadonlyMap<string, Coordinates>,
  memberships: ReadonlyMap<string, string>,
): number {
  const entries = [...anchors.entries()].sort(([left], [right]) => compareText(left, right));
  const nearest = entries.flatMap(([id, anchor]) => {
    const community = requiredCommunity(memberships, id);
    const candidates = entries
      .filter(([candidateId]) => candidateId !== id && requiredCommunity(memberships, candidateId) === community)
      .map(([, candidate]) => Math.hypot(anchor.x - candidate.x, anchor.y - candidate.y));
    return candidates.length === 0 ? [] : [Math.min(...candidates)];
  });
  if (nearest.length === 0) {
    return Number.NaN;
  }
  const mean = nearest.reduce((sum, distance) => sum + distance, 0) / nearest.length;
  const standardDeviation = Math.sqrt(nearest.reduce((sum, distance) => sum + ((distance - mean) ** 2), 0) / nearest.length);
  return standardDeviation / mean;
}

/** This lays every id on a single regular grid in sorted-id order and encodes no community structure. */
function uniformGridIdOrder(ids: readonly string[]): ReadonlyMap<string, Coordinates> {
  const spacing = 100;
  const columns = Math.ceil(Math.sqrt(ids.length));
  const anchors = new Map<string, Coordinates>();
  for (const [index, id] of ids.entries()) {
    const column = index % columns;
    const row = Math.floor(index / columns);
    anchors.set(id, { x: column * spacing, y: row * spacing, z: 0 });
  }
  return anchors;
}

/** This lays every community's own members on their own regular grid block, so within-community spacing is exactly uniform. */
function uniformGridCommunityBlocked(
  ids: readonly string[],
  memberships: ReadonlyMap<string, string>,
): ReadonlyMap<string, Coordinates> {
  const spacing = 10;
  const blockSeparation = 100000;
  const byCommunity = new Map<string, string[]>();
  for (const id of ids) {
    const community = requiredCommunity(memberships, id);
    byCommunity.set(community, [...(byCommunity.get(community) ?? []), id]);
  }
  const anchors = new Map<string, Coordinates>();
  for (const [blockIndex, community] of [...byCommunity.keys()].sort(compareText).entries()) {
    const members = [...requiredMembers(byCommunity, community)].sort(compareText);
    const columns = Math.ceil(Math.sqrt(members.length));
    for (const [index, id] of members.entries()) {
      const column = index % columns;
      const row = Math.floor(index / columns);
      anchors.set(id, { x: (blockIndex * blockSeparation) + (column * spacing), y: row * spacing, z: 0 });
    }
  }
  return anchors;
}

/** This lays every id on one shared, equally spaced ring in sorted-id order and encodes no community structure. */
function singleEquallySpacedRing(ids: readonly string[]): ReadonlyMap<string, Coordinates> {
  const radius = 100;
  const anchors = new Map<string, Coordinates>();
  for (const [index, id] of ids.entries()) {
    const angle = (Math.PI * 2 * index) / ids.length;
    anchors.set(id, { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius, z: 0 });
  }
  return anchors;
}

function requiredMembers(byCommunity: ReadonlyMap<string, string[]>, community: string): string[] {
  const members = byCommunity.get(community);
  if (members === undefined) {
    throw new TypeError(`missing community block for ${community}`);
  }
  return members;
}

function requiredCommunity(memberships: ReadonlyMap<string, string>, id: string): string {
  const community = memberships.get(id);
  if (community === undefined) {
    throw new TypeError(`missing pinned partition for ${id}`);
  }
  return community;
}

function requiredPinnedCommunity(id: string): string {
  const community = PINNED_DISCOVERY_PARTITION[id];
  if (community === undefined) {
    throw new TypeError(`pinned partition is missing ${id}`);
  }
  return community;
}

function requiredAnchor(anchors: ReadonlyMap<string, Coordinates>, id: string): Coordinates {
  const anchor = anchors.get(id);
  if (anchor === undefined) {
    throw new TypeError(`missing anchor ${id}`);
  }
  return anchor;
}

function structuralGraph(
  nodeIds: readonly string[],
  links: readonly (readonly [string, string])[],
): EngineGraph {
  return {
    nodes: nodeIds.map((id) => ({ id, kind: "node", visual: { role: "node", label_priority: 0 } })),
    edges: structuralEdges(links),
  };
}

function replaceEdges(graph: EngineGraph, links: readonly (readonly [string, string])[]): void {
  (graph as { edges: EngineGraph["edges"] }).edges = structuralEdges(links);
}

function structuralEdges(links: readonly (readonly [string, string])[]): EngineGraph["edges"] {
  return links.map(([source, target], index) => ({
    id: `edge:${index}`,
    kind: "edge",
    source,
    target,
    visual: { role: "edge", label_priority: 0 },
  }));
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function pearson(left: readonly number[], right: readonly number[]): number {
  assert.equal(left.length, right.length);
  const count = left.length;
  const leftMean = left.reduce((sum, value) => sum + value, 0) / count;
  const rightMean = right.reduce((sum, value) => sum + value, 0) / count;
  const covariance = left.reduce((sum, value, index) => sum + ((value - leftMean) * ((right[index] ?? rightMean) - rightMean)), 0);
  const leftDeviation = left.reduce((sum, value) => sum + ((value - leftMean) ** 2), 0);
  const rightDeviation = right.reduce((sum, value) => sum + ((value - rightMean) ** 2), 0);
  return covariance / Math.sqrt(leftDeviation * rightDeviation);
}
