import assert from "node:assert/strict";
import test from "node:test";
import { createEngineGraphView } from "../../src/engine/contract.ts";
import { DEFAULT_CALIBRATION } from "../../src/engine/calibration.ts";
import { createVisualState } from "../../src/engine/visual-state.ts";
import { indraOrganization } from "../../src/engine/organization.ts";
import { buildRenderModel } from "../../src/render2d/model.ts";
import { buildScene } from "../../src/scene/build.ts";
import { adaptReviewExport, censusOf, restrictAnchors, subgraph } from "../../src/review/product-adapter.ts";
import { relaxDepth } from "../../src/review/depth.ts";
import { placeLabels } from "../../src/review/labels.ts";
import type { ReviewExport, ReviewNode, ReviewEdge } from "../../src/review/model.ts";

const node = (id: string, type: ReviewNode["type"]): ReviewNode => ({ id, type, label: id, epistemic: "structural" });
const edge = (id: string, type: string, source: string, target: string): ReviewEdge => ({
  id,
  type,
  source,
  target,
  attested_by: "fixture",
  weight: 1,
  evidence_ids: [],
});
function fixture(): ReviewExport {
  return {
    schema: "nousos-graph-review-1",
    export_digest: "synthetic",
    notice: { it: "", en: "" },
    layouts: { "2d": {}, "3d": {} },
    nodes: [
      node("d", "domain"),
      node("c", "connection"),
      node("x", "candidate"),
      node("a", "canon"),
      node("v", "evidence"),
      node("r1", "record"),
      node("r2", "record"),
      node("q", "conversation"),
    ],
    edges: [
      edge("e1", "links", "c", "d"),
      edge("e2", "supported_by", "c", "v"),
      edge("e3", "distilled_as", "c", "x"),
      edge("e4", "promoted_as", "x", "a"),
      edge("e5", "in_conversation", "r1", "q"),
      edge("e6", "in_conversation", "r2", "q"),
    ],
  };
}
const mean = (values: number[]) => values.reduce((a, b) => a + b, 0) / values.length;
const options = {
  morphology: "stellar" as const,
  organization: "flat" as const,
  palette: "monochrome" as const,
  temperature: "balanced" as const,
  theme: "dark" as const,
  lodBand: "micro" as const,
  reducedMotion: true,
  elapsedMilliseconds: 0,
};
function state(graph: ReturnType<typeof adaptReviewExport>["graph"]) {
  return createVisualState(graph, {
    selectedId: null,
    focusedId: null,
    camera: { x: 0.5, y: 0.5, angle: 0, ratio: 1, bounds: { x: [-10, 10], y: [-10, 10] } },
    cameraKind: "orthographic",
    morphology: "stellar",
    organization: "flat",
    palette: "monochrome",
    temperature: "balanced",
    theme: "dark",
    lodBand: "micro",
    reducedMotion: true,
  });
}
test("adapter preserves ids and incidence without assertion or bridge carriers", () => {
  const data = fixture(),
    census = censusOf(data),
    prepared = adaptReviewExport(data);
  assert.equal(census.nodes, 8);
  assert.equal(census.edges, 6);
  assert.deepEqual(census.duplicateIds, []);
  assert.deepEqual(census.danglingEdges, []);
  assert.deepEqual(
    prepared.graph.nodes.map((n) => n.id),
    data.nodes.map((n) => n.id),
  );
  assert.deepEqual(
    prepared.graph.edges.map((e) => [e.id, e.source, e.target]),
    data.edges.map((e) => [e.id, e.source, e.target]),
  );
  assert(prepared.graph.nodes.every((n) => !["assertion", "bridge"].includes(n.kind) && n.rendered === null));
  assert(prepared.graph.edges.every((e) => e.rendered === null));
  assert.equal(prepared.graph.edges.find((e) => e.id === "e5")?.kind, "in_cluster");
  assert.deepEqual(
    [...prepared.originals.keys()],
    [...data.nodes, ...data.edges].map((x) => x.id),
  );
});
test("filtered anchors remain full-layout anchors and windows use visible members", () => {
  const p = adaptReviewExport(fixture()),
    ids = new Set(["q", "r1", "d", "c"]);
  const filtered = subgraph(p.graph, ids),
    anchors = restrictAnchors(p.indraAnchors, ids);
  for (const [id, pos] of anchors) assert.deepEqual(pos, p.indraAnchors.get(id));
  assert.equal(filtered.edges.length, 2);
  const windows = indraOrganization(createEngineGraphView(filtered).graph, DEFAULT_CALIBRATION, anchors, true).windows;
  assert.equal(windows.length, 1);
  assert.deepEqual(windows[0]?.members, ["r1"]);
  assert.deepEqual(windows[0]?.center, anchors.get("q"));
  assert(
    Math.hypot(anchors.get("r1")!.x - windows[0]!.center.x, anchors.get("r1")!.y - windows[0]!.center.y) <=
      windows[0]!.radius,
  );
  assert.equal(new Set(windows.flatMap((w) => w.members)).size, windows.flatMap((w) => w.members).length);
});
test("depth is deterministic, planar coordinates unchanged, and connected z distances are smaller", () => {
  const p = adaptReviewExport(fixture());
  const a = relaxDepth(p.graph, p.flatAnchors),
    b = relaxDepth(p.graph, p.flatAnchors);
  assert.deepEqual(a, b);
  for (const [id, pos] of a) {
    const base = p.flatAnchors.get(id)!;
    assert.equal(pos.x, base.x);
    assert.equal(pos.y, base.y);
  }
  const positions = [...a.values()],
    extent = Math.max(
      Math.max(...positions.map((p) => p.x)) - Math.min(...positions.map((p) => p.x)),
      Math.max(...positions.map((p) => p.y)) - Math.min(...positions.map((p) => p.y)),
    );
  assert(Math.max(...positions.map((p) => p.z)) - Math.min(...positions.map((p) => p.z)) >= 0.08 * extent);
  const connected = new Set(p.graph.edges.map((e) => [e.source, e.target].sort().join("|")));
  const connectedDistances: number[] = [],
    unconnectedDistances: number[] = [];
  for (let i = 0; i < p.graph.nodes.length; i++)
    for (let j = i + 1; j < p.graph.nodes.length; j++) {
      const left = p.graph.nodes[i]!.id,
        right = p.graph.nodes[j]!.id,
        d = Math.abs(a.get(left)!.z - a.get(right)!.z);
      (connected.has([left, right].sort().join("|")) ? connectedDistances : unconnectedDistances).push(d);
    }
  assert(mean(connectedDistances) < mean(unconnectedDistances));
});
test("label placement is bounded, collision free, and selected wins", () => {
  const bounds = { left: 10, top: 10, width: 180, height: 100 };
  const measure = (text: string) => ({ width: Math.min(100, text.length * 7 + 12), height: 22 });
  const labels = placeLabels(
    [
      { id: "a", text: "Selected", reason: "selected", x: 90, y: 50, priority: 0 },
      { id: "b", text: "Other", reason: "main", x: 90, y: 50, priority: 5 },
      { id: "c", text: "Outside", reason: "main", x: 500, y: 50, priority: 9 },
    ],
    bounds,
    measure,
  );
  assert.equal(labels[0]?.id, "a");
  for (const a of labels) {
    assert(
      a.rect.left >= bounds.left &&
        a.rect.top >= bounds.top &&
        a.rect.left + a.rect.width <= bounds.left + bounds.width &&
        a.rect.top + a.rect.height <= bounds.top + bounds.height,
    );
    for (const b of labels)
      if (a !== b)
        assert(
          a.rect.left + a.rect.width <= b.rect.left ||
            b.rect.left + b.rect.width <= a.rect.left ||
            a.rect.top + a.rect.height <= b.rect.top ||
            b.rect.top + b.rect.height <= a.rect.top,
        );
  }
});
test("empty presentation preserves Sigma model and R3F scene; options affect appearance only", () => {
  const p = adaptReviewExport(fixture());
  const a = buildRenderModel(p.graph, options, undefined, p.flatAnchors),
    b = buildRenderModel(p.graph, { ...options, presentation: {} }, undefined, p.flatAnchors);
  for (const id of a.graph.nodes()) assert.deepEqual(a.graph.getNodeAttributes(id), b.graph.getNodeAttributes(id));
  for (const id of a.graph.edges()) assert.deepEqual(a.graph.getEdgeAttributes(id), b.graph.getEdgeAttributes(id));
  const visual = state(p.graph),
    scene = buildScene(
      p.graph,
      visual,
      DEFAULT_CALIBRATION,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      p.flatAnchors,
    ),
    sceneEmpty = buildScene(
      p.graph,
      visual,
      DEFAULT_CALIBRATION,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      p.flatAnchors,
      {},
    );
  assert.deepEqual(scene, sceneEmpty);
  const presentation = {
    nativeLabels: false,
    emphasisIds: new Set(["c", "d"]),
    nodes: new Map([
      ["c", { corePermille: 1200, haloPermille: 1400, opacityPermille: 800, tintSrgb: [1, 0, 0] as const }],
    ]),
  };
  const model = buildRenderModel(p.graph, { ...options, presentation }, undefined, p.flatAnchors);
  assert.equal(model.graph.getNodeAttribute("c", "labelText"), "");
  assert.equal(model.graph.getEdgeAttribute("e1", "labelText"), "");
  assert.notEqual(model.graph.getNodeAttribute("c", "size"), a.graph.getNodeAttribute("c", "size"));
  assert.notEqual(model.graph.getNodeAttribute("v", "color"), a.graph.getNodeAttribute("v", "color"));
  assert.equal(model.graph.getNodeAttribute("d", "color"), a.graph.getNodeAttribute("d", "color"));
  const sceneReview = buildScene(
    p.graph,
    visual,
    DEFAULT_CALIBRATION,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    p.flatAnchors,
    presentation,
  );
  assert.equal(sceneReview.nodes.find((n) => n.id === "c")?.labelCandidacy, null);
  assert.equal(sceneReview.edges.find((e) => e.id === "e1")?.labelCandidacy, null);
  assert(
    (sceneReview.nodes.find((n) => n.id === "v")?.opacityPermille ?? 0) <
      (scene.nodes.find((n) => n.id === "v")?.opacityPermille ?? 0),
  );
  assert.equal(
    sceneReview.nodes.find((n) => n.id === "d")?.opacityPermille,
    scene.nodes.find((n) => n.id === "d")?.opacityPermille,
  );
});
test("empty presentation also preserves Indra models and scenes", () => {
  const p = adaptReviewExport(fixture()),
    indraOptions = { ...options, organization: "indra" as const };
  const a = buildRenderModel(p.graph, indraOptions, undefined, p.indraAnchors),
    b = buildRenderModel(p.graph, { ...indraOptions, presentation: {} }, undefined, p.indraAnchors);
  assert.deepEqual(a.windows, b.windows);
  for (const id of a.graph.nodes()) assert.deepEqual(a.graph.getNodeAttributes(id), b.graph.getNodeAttributes(id));
  const visual = createVisualState(p.graph, { ...state(p.graph), organization: "indra" });
  const scene = buildScene(
      p.graph,
      visual,
      DEFAULT_CALIBRATION,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      p.indraAnchors,
    ),
    empty = buildScene(
      p.graph,
      visual,
      DEFAULT_CALIBRATION,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      p.indraAnchors,
      {},
    );
  assert.deepEqual(scene, empty);
});
