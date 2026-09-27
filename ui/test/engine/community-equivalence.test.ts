import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { toVisualGraph } from "#adapter/projection.ts";
import { detectCommunities } from "#engine/community.ts";
import type { EngineGraph } from "#engine/contract.ts";

// Frozen from 3093b74. Keep the pairwise edge scan here as an independent
// reference for the one-pass rewrite; changing the production helper cannot
// change this oracle accidentally.

type StructuralEdge = {
  readonly source: string;
  readonly target: string;
};

type Community = {
  readonly key: string;
  readonly members: readonly string[];
  readonly degree: bigint;
};

type Merge = {
  readonly left: Community;
  readonly right: Community;
  readonly score: bigint;
};

/** The reference derives a deterministic partition from endpoints without reading relation meaning. */
function detectCommunitiesReference(graph: EngineGraph): ReadonlyMap<string, string> {
  const nodeIds = graph.nodes.map(({ id }) => id).sort(compareText);
  const knownNodeIds = new Set(nodeIds);
  if (knownNodeIds.size !== nodeIds.length) {
    throw new TypeError("community detection requires unique node ids");
  }
  const edges = graph.edges
    .map(({ source, target }) => ({ source, target }))
    .filter((edge) => knownNodeIds.has(edge.source) && knownNodeIds.has(edge.target))
    .sort(compareEdges);
  const degrees = degreesFor(nodeIds, edges);
  const communities = new Map<string, Community>(
    nodeIds.map((id) => [
      id,
      {
        key: id,
        members: [id],
        degree: requiredDegree(degrees, id),
      },
    ]),
  );
  const totalDegree = BigInt(edges.length) * 2n;

  while (totalDegree > 0n) {
    const merge = bestPositiveMerge(communities, edges, totalDegree);
    if (merge === undefined) {
      break;
    }
    const members = [...merge.left.members, ...merge.right.members].sort(compareText);
    const key = members[0];
    if (key === undefined) {
      throw new TypeError("community merge has no members");
    }
    communities.delete(merge.left.key);
    communities.delete(merge.right.key);
    communities.set(key, { key, members, degree: merge.left.degree + merge.right.degree });
  }

  const memberships = new Map<string, string>();
  for (const key of [...communities.keys()].sort(compareText)) {
    const community = requiredCommunity(communities, key);
    for (const id of community.members) {
      memberships.set(id, community.key);
    }
  }
  return new Map([...memberships.entries()].sort(([left], [right]) => compareText(left, right)));
}

function degreesFor(nodeIds: readonly string[], edges: readonly StructuralEdge[]): ReadonlyMap<string, bigint> {
  const degrees = new Map<string, bigint>(nodeIds.map((id) => [id, 0n]));
  for (const edge of edges) {
    degrees.set(edge.source, requiredDegree(degrees, edge.source) + 1n);
    degrees.set(edge.target, requiredDegree(degrees, edge.target) + 1n);
  }
  return degrees;
}

function bestPositiveMerge(
  communities: ReadonlyMap<string, Community>,
  edges: readonly StructuralEdge[],
  totalDegree: bigint,
): Merge | undefined {
  const keys = [...communities.keys()].sort(compareText);
  const keysByNodeId = communityKeysByNodeId(communities, keys);
  let best: Merge | undefined;
  for (const [leftIndex, leftKey] of keys.entries()) {
    const left = requiredCommunity(communities, leftKey);
    for (const rightKey of keys.slice(leftIndex + 1)) {
      const right = requiredCommunity(communities, rightKey);
      const edgesBetween = edgeCountBetween(left.key, right.key, keysByNodeId, edges);
      if (edgesBetween === 0n) {
        continue;
      }
      // This numerator is the Newman modularity merge delta scaled by the same
      // positive denominator for every candidate. BigInt keeps equal scores equal
      // instead of making the selected merge depend on floating-point rounding.
      const score = edgesBetween * totalDegree - left.degree * right.degree;
      if (score > 0n && (best === undefined || score > best.score)) {
        best = { left, right, score };
      }
    }
  }
  return best;
}

function communityKeysByNodeId(
  communities: ReadonlyMap<string, Community>,
  keys: readonly string[],
): ReadonlyMap<string, string> {
  const keysByNodeId = new Map<string, string>();
  for (const key of keys) {
    const community = requiredCommunity(communities, key);
    for (const id of community.members) {
      keysByNodeId.set(id, key);
    }
  }
  return keysByNodeId;
}

function edgeCountBetween(
  leftKey: string,
  rightKey: string,
  keysByNodeId: ReadonlyMap<string, string>,
  edges: readonly StructuralEdge[],
): bigint {
  let count = 0n;
  for (const edge of edges) {
    const sourceKey = requiredCommunityKey(keysByNodeId, edge.source);
    const targetKey = requiredCommunityKey(keysByNodeId, edge.target);
    if ((sourceKey === leftKey && targetKey === rightKey) || (sourceKey === rightKey && targetKey === leftKey)) {
      count += 1n;
    }
  }
  return count;
}

function requiredDegree(degrees: ReadonlyMap<string, bigint>, id: string): bigint {
  const degree = degrees.get(id);
  if (degree === undefined) {
    throw new TypeError("community degree is unavailable");
  }
  return degree;
}

function requiredCommunity(communities: ReadonlyMap<string, Community>, key: string): Community {
  const community = communities.get(key);
  if (community === undefined) {
    throw new TypeError("community is unavailable");
  }
  return community;
}

function requiredCommunityKey(keysByNodeId: ReadonlyMap<string, string>, id: string): string {
  const key = keysByNodeId.get(id);
  if (key === undefined) {
    throw new TypeError("community key is unavailable");
  }
  return key;
}

function compareEdges(left: StructuralEdge, right: StructuralEdge): number {
  const leftMinimum = left.source < left.target ? left.source : left.target;
  const rightMinimum = right.source < right.target ? right.source : right.target;
  const minimumComparison = compareText(leftMinimum, rightMinimum);
  if (minimumComparison !== 0) {
    return minimumComparison;
  }
  const leftMaximum = left.source < left.target ? left.target : left.source;
  const rightMaximum = right.source < right.target ? right.target : right.source;
  return compareText(leftMaximum, rightMaximum);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function structuralGraph(nodeCount: number, links: readonly (readonly [string, string])[]): EngineGraph {
  return {
    nodes: Array.from({ length: nodeCount }, (_, index) => ({
      id: `n${String(index).padStart(3, "0")}`,
      kind: "node",
      visual: { role: "node", label_priority: 0 },
    })),
    edges: links.map(([source, target], index) => ({
      id: `edge:${index}`,
      kind: "edge",
      source,
      target,
      visual: { role: "edge", label_priority: 0 },
    })),
  };
}

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function nodeId(index: number): string {
  return `n${String(index).padStart(3, "0")}`;
}

function seededGraph(nodeCount: number, shape: "sparse" | "dense" | "disconnected" | "ties"): EngineGraph {
  const random = seededRandom(0x067000 + nodeCount * 17 + shape.length);
  const links: [string, string][] = [];
  const active = nodeCount < 5 ? nodeCount : nodeCount - Math.max(1, Math.floor(nodeCount / 8));
  for (let source = 0; source < active; source += 1) {
    for (let target = source + 1; target < active; target += 1) {
      if (shape === "disconnected" && source % 2 !== target % 2) continue;
      const chance = shape === "dense" ? 0.16 : shape === "sparse" ? 0.035 : 0.075;
      if (random() < chance) links.push([nodeId(source), nodeId(target)]);
    }
  }
  if (shape === "ties") {
    // A cycle creates equal-degree candidates; duplicate edges and loops
    // exercise the exact tie-breaking and degree bookkeeping of both versions.
    for (let index = 0; index < active; index += 1) {
      links.push([nodeId(index), nodeId((index + 1) % active)]);
    }
  }
  if (active > 0) {
    const duplicateTarget = shape === "disconnected" ? (active > 2 ? 2 : 0) : Math.min(active - 1, 1);
    links.push([nodeId(0), nodeId(0)]);
    links.push([nodeId(0), nodeId(duplicateTarget)]);
    links.push([nodeId(0), nodeId(duplicateTarget)]);
  }
  return structuralGraph(nodeCount, links);
}

function assertEquivalent(graph: EngineGraph, label: string): void {
  assert.deepEqual([...detectCommunities(graph).entries()], [...detectCommunitiesReference(graph).entries()], label);
}

for (const nodeCount of [1, 2, 5, 12, 30, 60, 90]) {
  for (const shape of ["sparse", "dense", "disconnected", "ties"] as const) {
    test(`community rewrite matches pairwise reference: ${nodeCount} nodes, ${shape}`, () => {
      assertEquivalent(seededGraph(nodeCount, shape), `${nodeCount} nodes, ${shape}`);
    });
  }
}

// These are all governed projection fixtures loaded by the existing engine
// tests, including the temporal and Indra cases in their subdirectories.
const FIXTURE_PATHS = [
  ["discovery-all-time.json"],
  ["discovery-at-question.json"],
  ["reliability-all-time.json"],
  ["reliability-at-question.json"],
  ["substrate-all-time.json"],
  ["indra", "indra-community-windows.json"],
  ["indra", "indra-portal-windows.json"],
  ["temporal", "temporal-genesis.json"],
] as const;

for (const parts of FIXTURE_PATHS) {
  test(`community rewrite matches pairwise reference: ${parts.join("/")}`, () => {
    const path = join(fileURLToPath(new URL("../../../fixtures/synthetic/projection/", import.meta.url)), ...parts);
    const graph = toVisualGraph(JSON.parse(readFileSync(path, "utf8")) as unknown);
    assertEquivalent(graph, parts.join("/"));
  });
}

test("community detection stays below 1,500 ms on a seeded 400-node graph", () => {
  const random = seededRandom(0x400700);
  const links: [string, string][] = [];
  const seen = new Set<string>();
  while (links.length < 700) {
    const source = Math.floor(random() * 400);
    const target = Math.floor(random() * 400);
    const key = `${Math.min(source, target)}:${Math.max(source, target)}`;
    if (source === target || seen.has(key)) continue;
    seen.add(key);
    links.push([nodeId(source), nodeId(target)]);
  }
  const graph = structuralGraph(400, links);
  // The replaced pairwise scan took seconds at 172 nodes. This bound catches
  // accidental reintroduction without timing the deliberately slow reference.
  const start = performance.now();
  const memberships = detectCommunities(graph);
  const elapsed = performance.now() - start;
  assert.equal(memberships.size, 400);
  assert.ok(elapsed < 1500, `400-node detection took ${elapsed.toFixed(1)} ms`);
  console.log(`400-node community detection: ${elapsed.toFixed(1)} ms`);
});
