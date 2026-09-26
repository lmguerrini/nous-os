/** Synthetic-only review model checks. */
import assert from "node:assert/strict";
import test from "node:test";
import { attestationMeaning, badgeFor, changeMode, classColors, classMeaning, initialState, isCanonical, searchNode, selectionNeighbourhood, shapes, shortLabel, visibleGraph } from "../../src/review/model.ts";
import type { ReviewExport } from "../../src/review/model.ts";
const node = (id: string, type: ReviewExport["nodes"][number]["type"], epistemic: string) => ({ id, type, epistemic, label: id });
const data: ReviewExport = { schema: "nousos-graph-review-1", export_digest: "synthetic", notice: { it: "synthetic", en: "synthetic" },
  layouts: { "2d": {}, "3d": {} },
  nodes: [node("domain:Quillmap", "domain", "structural"), node("domain:FORGE", "domain", "structural"),
    node("connection:alpha", "connection", "A"), node("connection:beta", "connection", "B"),
    node("evidence:first", "evidence", "source"), node("record:first", "record", "source"),
    node("candidate:first", "candidate", "proposal"), node("canon:first", "canon", "canonical")],
  edges: [
    { id: "link-a", type: "links", source: "connection:alpha", target: "domain:Quillmap", attested_by: "synthetic", weight: 1, evidence_ids: [] },
    { id: "link-b", type: "links", source: "connection:beta", target: "domain:FORGE", attested_by: "synthetic", weight: 1, evidence_ids: [] },
    { id: "support", type: "supported_by", source: "connection:alpha", target: "evidence:first", attested_by: "synthetic", weight: 1, evidence_ids: [] },
    { id: "quote", type: "quotes", source: "evidence:first", target: "record:first", attested_by: "synthetic", weight: 1, evidence_ids: [] },
    { id: "distill", type: "distilled_as", source: "evidence:first", target: "candidate:first", attested_by: "synthetic", weight: 1, evidence_ids: [] },
    { id: "promote", type: "promoted_as", source: "candidate:first", target: "canon:first", attested_by: "synthetic", weight: 1, evidence_ids: [] },
  ] };
test("synthetic domain and class filters retain connected evidence and standing filters", () => {
  const filters = initialState().filters;
  const domain = visibleGraph(data, { ...filters, domain: "Quillmap" });
  assert.deepEqual(domain.nodes.map((item) => item.id), ["domain:Quillmap", "connection:alpha", "evidence:first", "record:first", "candidate:first", "canon:first"]);
  assert.deepEqual(visibleGraph(data, { ...filters, epistemicClass: "A" }).nodes.map((item) => item.id), domain.nodes.map((item) => item.id));
  assert.deepEqual(visibleGraph(data, { ...filters, standing: "source" }).nodes.map((item) => item.id), ["evidence:first", "record:first"]);
  assert.deepEqual(visibleGraph(data, { ...filters, nodeType: "canon" }).nodes.map((item) => item.id), ["canon:first"]);
});
test("synthetic selection and filters persist across mode changes; search by id and label", () => {
  const state = { ...initialState(), selected: "connection:alpha", filters: { ...initialState().filters, domain: "Quillmap" } };
  assert.deepEqual(changeMode(state, "3d"), { ...state, mode: "3d" });
  assert.equal(searchNode(data, "alpha")?.id, "connection:alpha");
  assert.equal(searchNode(data, "CONNECTION:BETA")?.id, "connection:beta");
});
test("synthetic neighbourhood includes incident edges and both ends of a selected relation", () => {
  const selected = selectionNeighbourhood(data, "connection:alpha");
  assert.deepEqual([...selected.primary], ["connection:alpha"]);
  assert.deepEqual([...selected.nodes], ["connection:alpha", "domain:Quillmap", "evidence:first"]);
  assert.deepEqual([...selected.edges], ["link-a", "support"]);
  const relation = selectionNeighbourhood(data, "support");
  assert.deepEqual([...relation.primary], ["connection:alpha", "evidence:first"]);
  assert.deepEqual([...relation.nodes], ["connection:alpha", "evidence:first", "domain:Quillmap", "record:first", "candidate:first"]);
  assert.deepEqual([...relation.edges], ["link-a", "support", "quote", "distill"]);
  assert.equal(selectionNeighbourhood({ nodes: data.nodes, edges: [] }, "support").nodes.size, 0);
  assert.equal(selectionNeighbourhood(data, null).edges.size, 0);
});
test("synthetic legend mapping keeps four class hues and canonical meaning", () => {
  assert.equal(new Set(Object.values(classColors)).size, 4);
  assert.equal(Object.keys(shapes).length, 7);
  assert.equal(isCanonical(data.nodes.at(-1)!), true);
  assert.equal(isCanonical(data.nodes.find((item) => item.id === "candidate:first")!), false);
});
test("synthetic class definitions pin the D-065 meanings", () => {
  assert.deepEqual(classMeaning, {
    A: "dichiarazione esplicita del fondatore",
    B: "conseguenza diretta sostenuta dal canone",
    C: "interpretazione forte non approvata",
    D: "analogia o ipotesi creativa",
  });
});
test("synthetic badges, attestation and short labels distinguish element kinds", () => {
  assert.equal(badgeFor(data.nodes.find((item) => item.id === "candidate:first")!, data), "CANONICO · proposta promossa");
  assert.equal(badgeFor(data.nodes.find((item) => item.id === "connection:alpha")!, data), "SCHEDA DI REVISIONE · NON CANONICA");
  assert.equal(badgeFor(data.nodes.find((item) => item.id === "evidence:first")!, data), "FONTE · testo citato, non una decisione");
  assert.equal(badgeFor(data.nodes.find((item) => item.id === "domain:Quillmap")!, data), "STRUTTURALE");
  assert.equal(attestationMeaning["canon.assertions"], "unione con il canone");
  assert.equal(shortLabel(data.nodes.find((item) => item.id === "candidate:first")!), "Proposta · :first");
});
