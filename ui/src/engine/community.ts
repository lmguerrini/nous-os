import type { EngineGraph } from "#engine/contract.ts";

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

/** This derives a deterministic structural partition from edge endpoints and does not read relation meaning or retain community state. */
export function detectCommunities(graph: EngineGraph): ReadonlyMap<string, string> {
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
  const communities = new Map<string, Community>(nodeIds.map((id) => [id, {
    key: id,
    members: [id],
    degree: requiredDegree(degrees, id),
  }]));
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
      const score = (edgesBetween * totalDegree) - (left.degree * right.degree);
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
