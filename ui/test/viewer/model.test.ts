import assert from "node:assert/strict";
import test from "node:test";
import { toVisualGraph } from "#adapter/projection.ts";
import { edgeClass, edgeDetailsFor, edgePanel, findNode, focusCameraForNeighbourhood, legendText, neighbourhood, nodeClass, nodePanel, runStatusSequence, statusText, threeDLabel } from "../../src/viewer/model.ts";
import type { DetailsPayload, NodeDetails } from "../../src/viewer/model.ts";

const graph = toVisualGraph({
  schema_version: "synthetic-1", policy_id: "discovery", question: { valid_at: null, recorded_as_of: null },
  nodes: [
    { id: "source:alpha", kind: "source", attributes: { source_id: "synthetic-alpha" } },
    { id: "subject:beta", kind: "subject", attributes: { key: "synthetic-beta" } },
    { id: "source:gamma", kind: "source", attributes: { source_id: "synthetic-gamma" } },
  ],
  edges: [
    { id: "edge:one", kind: "about", source: "source:alpha", target: "subject:beta", attributes: null },
  ],
});

const alpha: NodeDetails = {
  kind: "source", label: "Alpha example", origin: "real", status: "source", source_id: "synthetic-alpha",
  conversation_id: "synthetic-conversation", conversation_title: "Example conversation", role: "user",
  created_at: "2025-01-01T00:00:00Z", citation: { source_id: "synthetic-alpha", snapshot_digest: "synthetic-digest", start_byte: 12, end_byte: 24 },
  preview: "Synthetic preview only.",
};
const details: DetailsPayload = {
  schema: "nousos-graph-details-1", generated_at: "2025-01-01T00:00:00Z",
  sample: { conversations: [], counts: {} },
  nodes: {
    "source:alpha": alpha,
    "subject:beta": { ...alpha, label: "Beta example", kind: "subject", status: "candidate" },
    "source:gamma": { ...alpha, label: "Gamma example", source_id: "synthetic-gamma" },
  },
  edges: {
    "source:alpha->subject:beta": { kind: "about", origin: "structural", evidence: [alpha.citation!] },
    "rel:synthetic": { kind: "RELATED", origin: "explicit_relation",
      ends: ["source:synthetic-alpha", "source:synthetic-gamma"], end_labels: ["Alpha example", "Gamma example"],
      evidence: [alpha.citation!, { source_id: "synthetic-gamma", snapshot_digest: "synthetic-digest", start_byte: 30, end_byte: 44 }] },
  },
};

test("node and edge details map to panel fields", () => {
  const node = nodePanel("source:alpha", alpha);
  assert.equal(node.heading, "Alpha example");
  assert.deepEqual(node.rows.find((row) => row.label === "Citation bytes"), { label: "Citation bytes", value: "12–24" });
  assert.deepEqual(node.rows.find((row) => row.label === "Conversation title"), { label: "Conversation title", value: "Example conversation" });
  assert.equal(node.preview, "Synthetic preview only.");
  assert.deepEqual(node.rows[0], { label: "Stato", value: "Fonte" });
  const edge = edgeDetailsFor(graph, details, "edge:one");
  assert.ok(edge);
  assert.equal(edgePanel("edge:one", edge).rows.find((row) => row.label === "Evidence")?.value, "synthetic-alpha: 12–24");
});

test("node panel states canonical and proposal status and lists relation ends with evidence", () => {
  const canonical = nodePanel("assertion:canonical", { ...alpha, status: "canonical" }, details);
  const proposal = nodePanel("assertion:proposal", { ...alpha, status: "candidate" }, details);
  const structural = nodePanel("subject:synthetic", { ...alpha, status: "structural", source_id: null }, details);
  assert.equal(canonical.rows[0]?.value, "Decisione canonica");
  assert.equal(proposal.rows[0]?.value, "Proposta (non canonica)");
  assert.equal(structural.rows[0]?.value, "Strutturale");
  assert.equal(proposal.rows.find((row) => row.label === "Relazioni esplicite")?.value, "1");
  assert.match(proposal.rows.find((row) => row.label === "Altro capo")?.value ?? "", /Gamma example.*30–44/);
});

test("legend text separates drawn links from recorded explicit relations", () => {
  const legend = legendText(graph, details);
  assert.equal(legend.candidate, "Proposte (non canoniche): 1");
  assert.equal(legend.structural, "Collegamenti strutturali disegnati: 1");
  assert.equal(legend.explicit, "Relazioni esplicite registrate: 1 (elencate nel pannello, non disegnate)");
  assert.equal(legend.inferred, "Collegamenti inferiti: 0");
  assert.match(legend.shape ?? "", /stessa forma.*stato è nel pannello dettagli/);
});

test("status line sequence waits for paint before calculating layout", async () => {
  const seen: string[] = [];
  let painted: (() => void) | undefined;
  const waiting = new Promise<void>((resolve) => { painted = resolve; });
  const running = runStatusSequence(
    async () => { seen.push("loaded"); return graph; },
    (loaded) => { seen.push("layout"); return loaded.nodes.length; },
    (stage) => { seen.push(statusText(stage, graph)); },
    () => { seen.push("paint requested"); return waiting; },
    (_loaded, count) => { seen.push(`mounted ${count}`); },
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(seen, ["Caricamento dati…", "loaded", "Calcolo del layout (alcuni secondi)…", "paint requested"]);
  painted?.();
  await running;
  assert.deepEqual(seen.slice(4), ["layout", "mounted 3", "Grafo pronto: 3 nodi, 1 collegamenti disegnati."]);
});

test("legend classes distinguish node status and edge origin", () => {
  assert.deepEqual(["canonical", "candidate", "source", "structural"].map((status) => nodeClass({ status: status as NodeDetails["status"] })),
    ["canonical", "candidate", "source", "other"]);
  assert.deepEqual(["explicit_relation", "structural", "inferred"].map((origin) => edgeClass({ origin: origin as "explicit_relation" | "structural" | "inferred" })),
    ["explicit", "structural", "inferred"]);
});

test("3D label reports the actual z rule", () => {
  assert.equal(threeDLabel(), "3D prospettico — layout piano (z = 0)");
  assert.equal(threeDLabel("created_at"), "3D — z = tempo");
});

test("search and immediate neighbours use synthetic labels and graph incidence", () => {
  assert.equal(findNode(graph, details, " beta EXAMPLE "), "subject:beta");
  assert.equal(findNode(graph, details, "source:gam"), "source:gamma");
  assert.equal(findNode(graph, details, "absent"), null);
  assert.deepEqual(neighbourhood(graph, "source:alpha"), ["source:alpha", "subject:beta"]);
  assert.deepEqual(neighbourhood(graph, "source:gamma"), ["source:gamma"]);
  assert.deepEqual(neighbourhood(graph, "missing"), []);
});

test("focus neighbours uses one span for off-centre points in non-square bounds", () => {
  const bounds = { x: [0, 200], y: [0, 100] } as const;
  const camera = { x: 0.5, y: 0.5, angle: 0, ratio: 1, bounds };
  const framed = focusCameraForNeighbourhood(bounds, [{ x: 140, y: 70 }, { x: 160, y: 90 }], camera);
  assert.equal(framed.x, 0.75);
  assert.equal(framed.y, 0.65);
  assert.ok(Math.abs(framed.ratio - 0.15) < 1e-12);
});
