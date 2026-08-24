import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { toVisualGraph } from "#adapter/projection.ts";
import { DEFAULT_CALIBRATION } from "#engine/calibration.ts";
import type { Coordinates, VisualGraph } from "#engine/contract.ts";
import {
  curveControlPoint,
  distanceToFilament,
  drawPassGeometry,
  filamentGeometry,
  liveFilamentGeometry,
  pickPassGeometry,
  pickableAt,
  sampleFilament,
} from "#render2d/geometry.ts";
import { buildRenderModel } from "#render2d/model.ts";
import type { RenderOptions } from "#render2d/model.ts";

/** This reads one renderer input and does not create display attributes from the fixture directly. */
function graph(): VisualGraph {
  return toVisualGraph(JSON.parse(readFileSync(join(process.cwd(), "..", "fixtures", "synthetic", "projection", "discovery-at-question.json"), "utf8")) as unknown);
}

/** This supplies one complete renderer selection and does not select an animation frame. */
function options(reducedMotion: boolean): RenderOptions {
  return {
    morphology: "neural",
    organization: "indra",
    palette: "interstellar",
    temperature: "balanced",
    theme: "dark",
    lodBand: "micro",
    reducedMotion,
    elapsedMilliseconds: DEFAULT_CALIBRATION.lod.crossfadeDurationMs,
  };
}

/** This replaces opaque values with throwing accessors and does not alter derived or visual fields. */
function graphWithForbiddenSemantic(input: VisualGraph): VisualGraph {
  return {
    ...input,
    nodes: input.nodes.map(forbidNodeSemantic),
    edges: input.edges.map(forbidEdgeSemantic),
  };
}

function forbidNodeSemantic(node: VisualGraph["nodes"][number]): VisualGraph["nodes"][number] {
  const protectedNode = { ...node };
  Object.defineProperty(protectedNode, "semantic", { get(): never { throw new Error("renderer read semantic node data"); } });
  return protectedNode;
}

function forbidEdgeSemantic(edge: VisualGraph["edges"][number]): VisualGraph["edges"][number] {
  const protectedEdge = { ...edge };
  Object.defineProperty(protectedEdge, "semantic", { get(): never { throw new Error("renderer read semantic edge data"); } });
  return protectedEdge;
}

test("the graphology graph retains every visual graph id and engine anchor", () => {
  const visualGraph = graph();
  const model = buildRenderModel(visualGraph, options(false));
  assert.equal(model.graph.order, visualGraph.nodes.length);
  assert.equal(model.graph.size, visualGraph.edges.length);
  assert.deepEqual(model.graph.nodes(), visualGraph.nodes.map((node) => node.id));
  assert.deepEqual(model.graph.edges(), visualGraph.edges.map((edge) => edge.id));
  assert.equal(model.anchors.size, visualGraph.nodes.length);
  for (const node of visualGraph.nodes) {
    const anchor = model.anchors.get(node.id);
    const display = model.graph.getNodeAttributes(node.id);
    assert.ok(anchor !== undefined);
    assert.equal(display.x, anchor.x);
    assert.equal(display.y, anchor.y);
  }
  assert.equal(model.windows.length, visualGraph.nodes.filter((node) => node.kind === "cluster" || node.kind === "conflict").length);
  assert.equal(model.organization.rejectionBounds.length, visualGraph.nodes.filter((node) => node.kind === "rejection").length);
});

test("display decisions reject semantic access", () => {
  const model = buildRenderModel(graphWithForbiddenSemantic(graph()), options(false));
  assert.ok(model.graph.order > 0);
  assert.ok(model.graph.size > 0);
  assert.equal(model.graph.order, model.anchors.size);
});

test("draw and pick bind the same quadratic geometry, including a straight filament", () => {
  const source: Coordinates = { x: 0, y: 0, z: 0 };
  const target: Coordinates = { x: 8, y: 0, z: 0 };
  const curved = filamentGeometry(source, target, DEFAULT_CALIBRATION.filament.curvatureMagnitudePermille / DEFAULT_CALIBRATION.morphology.stellar.opacityPermille);
  const expectedControl = { x: 4, y: 1.92, z: 0 };
  assert.deepEqual(curveControlPoint(source, target, DEFAULT_CALIBRATION.filament.curvatureMagnitudePermille / DEFAULT_CALIBRATION.morphology.stellar.opacityPermille), expectedControl);
  assert.equal(liveFilamentGeometry, filamentGeometry);
  assert.equal(drawPassGeometry(curved).geometry, pickPassGeometry(curved).geometry);
  const straight = filamentGeometry(source, target, 0);
  const straightSamples = sampleFilament(straight, DEFAULT_CALIBRATION);
  assert.equal(straightSamples.length, 2);
  assert.deepEqual(straightSamples, [source, target]);
  const ownLine = { x: 4, y: 0, z: 0 };
  assert.equal(distanceToFilament(straight, ownLine, DEFAULT_CALIBRATION), 0);
  assert.equal(pickableAt(pickPassGeometry(straight), ownLine, DEFAULT_CALIBRATION.filament.baseWidthPx, DEFAULT_CALIBRATION), true);
});

test("reduced motion changes propagation output and leaves all other render decisions intact", () => {
  const visualGraph = graph();
  const ordinary = buildRenderModel(visualGraph, options(false));
  const reduced = buildRenderModel(visualGraph, options(true));
  assert.deepEqual(ordinary.graph.export(), reduced.graph.export());
  assert.deepEqual(ordinary.anchors, reduced.anchors);
  assert.deepEqual(ordinary.windows, reduced.windows);
  assert.deepEqual(ordinary.organization, reduced.organization);
  assert.deepEqual(ordinary.tokens, reduced.tokens);
  assert.deepEqual(ordinary.filaments, reduced.filaments);
  assert.equal(ordinary.propagation.size, visualGraph.edges.length);
  assert.equal(reduced.propagation.size, visualGraph.edges.length);
  for (const edge of visualGraph.edges) {
    const ordinaryState = ordinary.propagation.get(edge.id);
    const reducedState = reduced.propagation.get(edge.id);
    assert.ok(ordinaryState !== undefined);
    assert.ok(reducedState !== undefined);
    assert.equal(ordinaryState.continuous, true);
    assert.equal(ordinaryState.endpointExpressed, false);
    assert.equal(reducedState.continuous, false);
    assert.equal(reducedState.endpointExpressed, true);
  }
});

test("render decisions contain no non-structural numeric literals", () => {
  const files = ["geometry.ts", "model.ts", "filament-program.ts", "index.ts"];
  assert.equal(files.length, 4);
  for (const file of files) {
    const decisions = readFileSync(join(process.cwd(), "src", "render2d", file), "utf8");
    const code = decisions.replace(/`[\s\S]*?`|"(?:\\.|[^"\\])*"/g, "");
    const literals = code.match(/(?<![A-Za-z])(?:[3-9]\d*|\d{2,})(?:\.\d+)?/g) ?? [];
    assert.deepEqual(literals, []);
  }
  assert.equal(files.length, 4);
});
