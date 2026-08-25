import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { toVisualGraph } from "#adapter/projection.ts";
import { detectCommunities } from "#engine/community.ts";
import type { EngineGraph, VisualGraph } from "#engine/contract.ts";

// This independent Python-derived mapping grades the detector; the detector is
// not used to construct any expected membership or edge classification below.
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

/** This reads a checked-in projection and does not manufacture graph structure. */
function graph(name: string): VisualGraph {
  return toVisualGraph(JSON.parse(readFileSync(join(process.cwd(), "..", "fixtures", "synthetic", "projection", name), "utf8")) as unknown);
}

/** This serialises a derived partition and does not preserve source insertion order. */
function recordOf(memberships: ReadonlyMap<string, string>): Record<string, string> {
  return Object.fromEntries([...memberships.entries()].sort(([left], [right]) => compareText(left, right)));
}

test("greedy modularity partition ignores node array order", () => {
  const discovery = graph("discovery-at-question.json");
  const forward = detectCommunities(discovery);
  const reversedNodes = detectCommunities({ ...discovery, nodes: [...discovery.nodes].reverse() });

  assert.deepEqual(recordOf(forward), recordOf(reversedNodes));
});

test("greedy modularity partition ignores edge array order", () => {
  const discovery = graph("discovery-at-question.json");
  const forward = detectCommunities(discovery);
  const reversedEdges = detectCommunities({ ...discovery, edges: [...discovery.edges].reverse() });

  assert.deepEqual(recordOf(forward), recordOf(reversedEdges));
});

test("greedy modularity reproduces the independently pinned Discovery partition node for node", () => {
  const discovery = graph("discovery-all-time.json");
  const memberships = detectCommunities(discovery);

  assert.deepEqual(recordOf(memberships), PINNED_DISCOVERY_PARTITION);
});

test("the pinned Discovery partition retains measured community sizes and edge counts", () => {
  const discovery = graph("discovery-all-time.json");
  const pinnedMemberships = new Map(Object.entries(PINNED_DISCOVERY_PARTITION));
  const sizes = [...communitySizes(pinnedMemberships).values()].sort((left, right) => right - left);
  const edgeCounts = discovery.edges.reduce((counts, edge) => {
    const source = requiredPinnedCommunity(edge.source);
    const target = requiredPinnedCommunity(edge.target);
    return source === target
      ? { intra: counts.intra + 1, bridges: counts.bridges }
      : { intra: counts.intra, bridges: counts.bridges + 1 };
  }, { intra: 0, bridges: 0 });

  assert.deepEqual(sizes, [6, 6, 5, 3, 2]);
  assert.equal(edgeCounts.intra, 24);
  assert.equal(edgeCounts.bridges, 3);
});

test("greedy modularity keeps disconnected triangles separate", () => {
  const triangles = structuralGraph(
    ["a", "b", "c", "d", "e", "f"],
    [["a", "b"], ["b", "c"], ["c", "a"], ["d", "e"], ["e", "f"], ["f", "d"]],
  );
  const partition = detectCommunities(triangles);
  assert.deepEqual(recordOf(partition), { a: "a", b: "a", c: "a", d: "d", e: "d", f: "d" });
  assert.notEqual(partition.get("a"), partition.get("d"));
});

test("greedy modularity keeps isolated nodes individual", () => {
  const isolated = structuralGraph(["a", "b", "c"], []);
  assert.deepEqual(recordOf(detectCommunities(isolated)), { a: "a", b: "b", c: "c" });
});

test("every input node has one derived community key", () => {
  const discovery = graph("discovery-at-question.json");
  const memberships = detectCommunities(discovery);

  assert.equal(memberships.size, discovery.nodes.length);
  for (const node of discovery.nodes) {
    assert.ok(memberships.has(node.id), `missing partition for ${node.id}`);
  }
});

function communitySizes(memberships: ReadonlyMap<string, string>): ReadonlyMap<string, number> {
  const sizes = new Map<string, number>();
  for (const key of [...memberships.values()].sort(compareText)) {
    sizes.set(key, (sizes.get(key) ?? 0) + 1);
  }
  return sizes;
}

function requiredPinnedCommunity(id: string): string {
  const community = PINNED_DISCOVERY_PARTITION[id];
  if (community === undefined) {
    throw new TypeError(`pinned partition is missing ${id}`);
  }
  return community;
}

function structuralGraph(
  nodeIds: readonly string[],
  links: readonly (readonly [string, string])[],
): EngineGraph {
  return {
    nodes: nodeIds.map((id) => ({ id, kind: "node", visual: { role: "node", label_priority: 0 } })),
    edges: links.map(([source, target], index) => ({
      id: `edge:${index}`,
      kind: "edge",
      source,
      target,
      visual: { role: "edge", label_priority: 0 },
    })),
  };
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
