/**
 * End-to-end adapter tests: determinism, the relation↔edge bijection, offsets,
 * acceptance by the page's own validator, and the synthetic profiles' calibration
 * targets. All generated data lives under adapter/test/.tmp/.
 */
import { deepStrictEqual, ok, strictEqual, throws } from "node:assert";
import { createHash } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { test } from "node:test";
import { canonicalJsonText } from "../src/canonical-json.ts";
import { fitLabel, kbToReviewGraph } from "../src/kb-to-review-graph.ts";
import type { KbSnapshot } from "../src/kb-types.ts";
import { generateSyntheticKb } from "../src/synthetic-kb.ts";
import { buildDetails, buildDatasetFiles } from "../src/write-dataset.ts";

const fourFiles = ["index.json", "details.jsonl", "details-offsets.json", "manifest.json"] as const;

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function digestOf(kb: KbSnapshot): Record<string, string> {
  const built = buildDatasetFiles(kbToReviewGraph(kb));
  const hashes: Record<string, string> = {};
  for (const name of [...fourFiles, "kb.json"] as const) {
    const bytes = name === "kb.json" ? new TextEncoder().encode(`${canonicalJsonText(kb)}\n`) : built.files[name]!;
    hashes[name] = sha256(bytes);
  }
  return hashes;
}

test("determinism: the same seed yields identical bytes for every file", () => {
  const first = digestOf(generateSyntheticKb("small", 1));
  const second = digestOf(generateSyntheticKb("small", 1));
  deepStrictEqual(first, second);
  const other = digestOf(generateSyntheticKb("small", 2));
  ok(other["index.json"] !== first["index.json"], "a different seed should change the dataset");
});

test("one index edge per KB relation and nothing else", () => {
  const kb = generateSyntheticKb("small", 7);
  const result = kbToReviewGraph(kb);
  const relationById = new Map(kb.relations.map(relation => [relation.id, relation]));
  strictEqual(result.index.edges.length, kb.relations.length);
  const nodeIds = new Set(kb.nodes.map(node => node.id));
  for (const edge of result.index.edges) {
    const relation = relationById.get(edge.id);
    ok(relation !== undefined, `edge ${edge.id} has no relation`);
    strictEqual(edge.source, relation.source);
    strictEqual(edge.target, relation.target);
    strictEqual(edge.type, relation.type);
    strictEqual(edge.directed, relation.directed);
    ok(edge.class === "attested" || edge.class === "exploratory", "no class other than attested/exploratory");
    ok(nodeIds.has(edge.source) && nodeIds.has(edge.target));
    if (edge.class === "exploratory") {
      strictEqual(edge.status, "exploratory/non-canonical");
      ok(typeof edge.explanation === "string" && edge.explanation.length > 0);
    } else {
      strictEqual(edge.status, undefined);
      strictEqual(edge.explanation, undefined);
    }
  }
  strictEqual(new Set(result.index.edges.map(edge => edge.id)).size, result.index.edges.length, "edge ids unique");
});

test("details offsets point at the start of each record's line", async () => {
  const kb = generateSyntheticKb("small", 3);
  const result = kbToReviewGraph(kb);
  const { text, offsets } = buildDetails(result);
  const bytes = new TextEncoder().encode(text);
  const decoder = new TextDecoder();
  const lines = new Map<string, string>();
  for (const [id, offset] of Object.entries(offsets)) {
    let end = offset;
    while (end < bytes.length && bytes[end] !== 0x0a) end += 1;
    const line = decoder.decode(bytes.slice(offset, end + 1));
    ok(line.endsWith("\n"));
    strictEqual(JSON.parse(line).id, id);
    lines.set(id, line);
  }
  strictEqual(lines.size, result.details.length, "one offset per details record");
  strictEqual([...lines.values()].join(""), text, "offsets cover the whole file in order");
});

test("the page's own validateIndex accepts the generated index", async () => {
  const { validateIndex } = await import("../../ui/src/review/graph-v2.ts");
  for (const profile of ["small", "reference"] as const) {
    const kb = generateSyntheticKb(profile, 1);
    const result = kbToReviewGraph(kb);
    const index = validateIndex(JSON.parse(canonicalJsonText(result.index)));
    strictEqual(index.nodes.length, kb.nodes.length);
    for (const node of index.nodes) {
      ok(node.size >= 0 && node.size <= 1);
      ok(Number.isFinite(node.importance.value));
      ok(Array.isArray(node.parents) && Array.isArray(node.domains));
      const label = node.display_label ?? node.title;
      ok([...label].length <= 33, `display_label fits 33 characters: ${label}`);
    }
  }
});

test("domains, primary_domain and parents follow the approved data convention", () => {
  for (const profile of ["small", "reference"] as const) {
    const kb = generateSyntheticKb(profile, 1);
    const result = kbToReviewGraph(kb);
    const rootKeys = new Set(kb.nodes.filter(node => node.parent === null).map(node => node.id.slice("domain:".length)));
    // The page's domain panel: level-3 nodes whose domains include the root's bare key.
    const panelCounts = new Map<string, number>();
    for (const node of result.index.nodes) {
      ok(node.domains.length > 0, `"${node.id}" lists at least one domain`);
      for (const key of node.domains) {
        ok(rootKeys.has(key), `domain "${key}" of "${node.id}" is the bare key of an existing root`);
      }
      strictEqual(new Set(node.domains).size, node.domains.length, `"${node.id}" domains are deduplicated`);
      if (node.level === 3) {
        strictEqual(node.primary_domain, node.domains[0], `"${node.id}" primary_domain is domains[0]`);
        for (const key of node.domains) panelCounts.set(key, (panelCounts.get(key) ?? 0) + 1);
      } else {
        strictEqual(node.primary_domain, undefined, `"${node.id}" carries no primary_domain outside level 3`);
      }
      if (node.level === 1) {
        deepStrictEqual(node.parents, [], `"${node.id}" is a root`);
        deepStrictEqual(node.domains, [node.id.slice("domain:".length)], `"${node.id}" lists its own key`);
      } else {
        strictEqual(node.parents[0], node.parent, `"${node.id}" parents start with the primary parent`);
        strictEqual(new Set(node.parents).size, node.parents.length, `"${node.id}" parents are deduplicated`);
      }
    }
    for (const key of rootKeys) {
      ok((panelCounts.get(key) ?? 0) > 0, `the page's panel rule counts > 0 level-3 nodes for root "${key}"`);
    }
  }
});

test("profile small calibration targets", () => {
  const kb = generateSyntheticKb("small", 1);
  strictEqual(kb.nodes.length, 600);
  strictEqual(kb.nodes.filter(node => node.kind === "domain").length, 9);
  strictEqual(kb.nodes.filter(node => node.level_skip).length, 22);
  strictEqual(kb.nodes.filter(node => node.parents && node.parents.length > 0).length, 14);
  strictEqual(kb.passages.length, 560);
  const manifest = kbToReviewGraph(kb).manifestWithoutDigest.counts;
  strictEqual(manifest.nodes_by_level["4"], 557);
  strictEqual(manifest.nodes_by_status.canon, 1);
  strictEqual(manifest.nodes_by_status["non-canonical/attested"], 2);
  strictEqual(manifest.edges_by_type.mentions, 230);
  strictEqual(manifest.edges_by_class.exploratory, 16);
});

test("profile reference targets (illustrative counts; 11,199 nodes and 9 domains are the product constraints)", () => {
  const kb = generateSyntheticKb("reference", 1);
  strictEqual(kb.nodes.length, 11199);
  const byKind = kb.nodes.reduce<Record<string, number>>((counts, node) => {
    counts[node.kind] = (counts[node.kind] ?? 0) + 1;
    return counts;
  }, {});
  deepStrictEqual(byKind, {
    domain: 9, project: 10, system: 12, work: 8,
    conversation: 150, attachment_source: 120, non_conversation_source: 80, proposal: 10810,
  });
  strictEqual(kb.nodes.filter(node => node.level_skip).length, 300);
  strictEqual(kb.nodes.filter(node => node.parents && node.parents.length > 0).length, 250);
  strictEqual(kb.passages.length, 10850);
  const result = kbToReviewGraph(kb);
  const counts = result.manifestWithoutDigest.counts;
  deepStrictEqual(counts.nodes_by_level, { "1": 9, "2": 30, "3": 350, "4": 10810 });
  deepStrictEqual(counts.nodes_by_status, { canon: 20, "non-canonical/attested": 40, proposal: 10750 });
  deepStrictEqual(counts.edges_by_type, {
    mentions: 4000, classified_in: 400, relates: 10,
    application: 60, continuity: 50, analogy: 30, dependency: 20, resonance: 10, card: 10, contradiction: 20,
  });
  deepStrictEqual(counts.edges_by_class, { attested: 4410, exploratory: 200 });
  strictEqual(counts.level_skip, 300);
  // Heavy-tailed proposal spread: some containers with >= 500 children, many with 0-5.
  const perContainer = new Map<string, number>();
  for (const node of kb.nodes) {
    if (node.kind === "proposal") perContainer.set(node.parent!, (perContainer.get(node.parent!) ?? 0) + 1);
  }
  const sizes = [...perContainer.values()];
  ok(sizes.filter(count => count >= 500).length >= 5, "several containers hold 500+ proposals");
  ok(sizes.filter(count => count <= 5).length >= 100, "many containers hold 0-5 proposals");
  ok(kb.nodes.every(node => node.kind !== "proposal" || node.status !== undefined), "every proposal carries a status");
  ok(kb.nodes.every(node => node.kind === "proposal" || node.status === undefined), "no status above level 4");
});

test("display labels fit 33 characters on a word boundary", () => {
  strictEqual(fitLabel("short title"), "short title");
  strictEqual(fitLabel("Bodar miral nolvel xadro quslim toven mirab"), "Bodar miral nolvel xadro quslim…");
  const fitted = fitLabel("x".repeat(80));
  strictEqual([...fitted].length, 33);
  ok(fitted.endsWith("…"));
});

test("fixtures on disk match a fresh build from the same seed", async () => {
  const fresh = digestOf(generateSyntheticKb("small", 1));
  const stored = await readFile(new URL("../fixtures/kb-small.json", import.meta.url), "utf8");
  const storedKb = JSON.parse(stored) as KbSnapshot;
  const storedDigest = digestOf(storedKb);
  deepStrictEqual(fresh["manifest.json"], storedDigest["manifest.json"]);
});

test("invalid inputs are rejected", () => {
  const base = (): KbSnapshot => {
    const citation = { source_id: "n1", snapshot_digest: "a".repeat(64), start_byte: 0, end_byte: 20, span: "qel mirab." };
    return {
      schema: "nousos.demo-kb/1",
      nodes: [
        { id: "domain:d1", kind: "domain", level: 1, title: "Qodor", parent: null },
        { id: "conversation:c1", kind: "conversation", level: 3, title: "Vuno", parent: "domain:d1", level_skip: true },
        { id: "proposal:c1-0001", kind: "proposal", level: 4, title: "Mirab", parent: "conversation:c1", status: "proposal", statement: "Sel toven.", citations: [citation] },
        { id: "proposal:c1-0002", kind: "proposal", level: 4, title: "Xador", parent: "conversation:c1", status: "proposal", statement: "Gol nirim." },
      ],
      relations: [
        { id: "rel:mentions-0001", source: "proposal:c1-0001", target: "proposal:c1-0002", type: "mentions", directed: true, class: "attested", evidence: [citation] },
      ],
      passages: [
        { node: "proposal:c1-0001", n: 1, citation, record: { kind: "message", role: "user", date: "2025-01-02" } },
      ],
    };
  };
  ok(kbToReviewGraph(base()).index.nodes.length === 4, "the base snapshot adapts");

  const duplicateRelationId = base();
  duplicateRelationId.relations.push({ ...duplicateRelationId.relations[0]! });
  throws(() => kbToReviewGraph(duplicateRelationId), /duplicate relation id/);

  const missingEndpoint = base();
  missingEndpoint.relations[0]!.target = "proposal:missing";
  throws(() => kbToReviewGraph(missingEndpoint), /unknown target/);

  const selfLoop = base();
  selfLoop.relations[0]!.target = selfLoop.relations[0]!.source;
  throws(() => kbToReviewGraph(selfLoop), /self-loop/);

  const unknownClass = base();
  (unknownClass.relations[0]! as unknown as { class: string }).class = "decorative";
  throws(() => kbToReviewGraph(unknownClass), /unknown class/);

  const parentNotLower = base();
  parentNotLower.nodes[3]!.parent = "proposal:c1-0001";
  throws(() => kbToReviewGraph(parentNotLower), /lower level/);

  const cycle = base();
  cycle.nodes[1]!.parent = "proposal:c1-0002";
  throws(() => kbToReviewGraph(cycle), /lower level|cycle/);

  const duplicateNodeId = base();
  duplicateNodeId.nodes.push({ ...duplicateNodeId.nodes[3]! });
  throws(() => kbToReviewGraph(duplicateNodeId), /duplicate node id/);

  const badId = base();
  badId.nodes[3]!.id = "proposal with spaces";
  throws(() => kbToReviewGraph(badId), /match/);

  const exploratoryWithoutExplanation = base();
  exploratoryWithoutExplanation.relations.push({
    id: "rel:analogy-0001", source: "proposal:c1-0001", target: "proposal:c1-0002",
    type: "analogy", directed: false, class: "exploratory", evidence: [],
  });
  throws(() => kbToReviewGraph(exploratoryWithoutExplanation), /explanation/);

  const passageOnContainer = base();
  passageOnContainer.passages[0]!.node = "conversation:c1";
  throws(() => kbToReviewGraph(passageOnContainer), /level-4/);

  const unknownKind = base();
  (unknownKind.nodes[0]! as unknown as { kind: string }).kind = "neighbourhood";
  throws(() => kbToReviewGraph(unknownKind), /unknown kind/);

  const levelMismatch = base();
  levelMismatch.nodes[2]!.level = 3;
  throws(() => kbToReviewGraph(levelMismatch), /level 4/);

  const badMembership = base();
  badMembership.nodes[2]!.parents = ["project:missing"];
  throws(() => kbToReviewGraph(badMembership), /unknown additional parent/);

  const membershipRepeatsParent = base();
  membershipRepeatsParent.nodes[1]!.parents = ["domain:d1"];
  throws(() => kbToReviewGraph(membershipRepeatsParent), /repeats its primary parent/);

  const levelSkipMisuse = base();
  levelSkipMisuse.nodes[3]!.level_skip = true;
  throws(() => kbToReviewGraph(levelSkipMisuse), /outside the level-3-under-root case/);

  const rootWithoutDomainPrefix = base();
  rootWithoutDomainPrefix.nodes[0]!.id = "domus:d1";
  rootWithoutDomainPrefix.nodes[1]!.parent = "domus:d1";
  throws(() => kbToReviewGraph(rootWithoutDomainPrefix), /domain:<key>/);

  const domainNotAtLevel1 = base();
  domainNotAtLevel1.nodes[2]!.domains = ["conversation:c1"];
  throws(() => kbToReviewGraph(domainNotAtLevel1), /not a level-1 node id/);
});

test("cleanup", async () => {
  await rm(new URL("./.tmp/", import.meta.url).pathname, { recursive: true, force: true });
});
