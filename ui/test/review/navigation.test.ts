import { test } from "node:test";
import assert from "node:assert/strict";
import { navigationFor } from "../../src/review/navigation.ts";
import type { ReviewExport } from "../../src/review/model.ts";
const data = { schema: "nousos-graph-review-1", export_digest: "digest", nodes: [
  { id: "card", type: "connection", label: "card", epistemic: "A" },
  { id: "span", type: "evidence", label: "span", epistemic: "source" },
  { id: "record", type: "record", label: "record", epistemic: "source" },
  { id: "chat", type: "conversation", label: "chat", epistemic: "structural" },
  { id: "domain", type: "domain", label: "domain", epistemic: "structural" },
  { id: "near", type: "domain", label: "near", epistemic: "structural" },
], edges: [
  { id: "s", type: "supported_by", source: "card", target: "span" },
  { id: "q", type: "quotes", source: "span", target: "record" },
  { id: "i", type: "in_conversation", source: "record", target: "chat" },
  { id: "c", type: "classified_in", source: "chat", target: "domain" },
], layouts: { "2d": {}, "3d": {} }, notice: { it: "", en: "" } } as ReviewExport;
test("navigation follows the supported quotation and membership chain", () => {
  const result = navigationFor(data, "card");
  assert.equal(result.passage.targets[0]?.id, "span"); assert.ok(result.passage.targets[0]?.source_edge_ids.includes("q"));
  assert.equal(result.conversation.targets[0]?.id, "chat"); assert.equal(result.work.available, false);
  assert.equal(result.constellation.targets[0]?.id, "domain"); assert.ok(result.constellation.targets[0]?.source_edge_ids.includes("c"));
  assert.ok(!result.constellation.targets.some((target) => target.id === "near"));
});
