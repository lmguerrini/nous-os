import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { toVisualGraph } from "#adapter/projection.ts";
import { DEFAULT_AGGREGATE_LAYOUT_CALIBRATION } from "#engine/calibration.ts";
import type { Coordinates, VisualGraph } from "#engine/contract.ts";
import { aggregateDiscs, aggregateMemberships, layoutAnchors, sharedAnchors } from "#engine/layout.ts";

const FIXTURE_NAMES = [
  "discovery-all-time.json",
  "discovery-at-question.json",
  "reliability-all-time.json",
  "reliability-at-question.json",
  "substrate-all-time.json",
] as const;

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
