import { test } from "node:test";
import assert from "node:assert/strict";
import { humanLabel, shortHumanLabel } from "../../src/review/model.ts";
import type { ReviewNode } from "../../src/review/model.ts";
test("product labels use source words and hide raw proposal and record identifiers", () => {
  const empty = { nodes: [], edges: [] };
  const record = {
    id: "record:src_abc",
    type: "record",
    label: "src_abc",
    epistemic: "source",
    role: "user",
    date: "2026-01-01",
  } as ReviewNode;
  const proposal = { id: "candidate:abc", type: "candidate", label: "asr_abc", epistemic: "proposal" } as ReviewNode;
  assert.equal(humanLabel(record, empty), "Messaggio del fondatore · 2026-01-01");
  assert.equal(humanLabel(proposal, empty), "Proposta di asserzione");
  assert.equal(shortHumanLabel("Atlasfield è l'archivio, le parti hanno margini"), "Atlasfield è l'archivio, le…");
});
