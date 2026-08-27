import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { toVisualGraph } from "#adapter/projection.ts";
import { ORTHOGRAPHIC } from "#engine/camera-kind.ts";
import { DEFAULT_CALIBRATION } from "#engine/calibration.ts";
import { semanticDigest } from "#engine/contract.ts";
import type { VisualGraph } from "#engine/contract.ts";
import { createVisualState } from "#engine/visual-state.ts";
import { buildRenderModel, selectedProvenanceForVisualState } from "#render2d/model.ts";
import type { RenderOptions } from "#render2d/model.ts";
import { parseColor } from "sigma/utils";

/** This reads one renderer input and does not manufacture graph structure. */
function graph(): VisualGraph {
  return toVisualGraph(JSON.parse(readFileSync(join(process.cwd(), "..", "fixtures", "synthetic", "projection", "discovery-at-question.json"), "utf8")) as unknown);
}

/** This supplies one complete renderer selection and does not select a graph element. */
function options(): RenderOptions {
  return {
    morphology: "neural",
    organization: "indra",
    palette: "interstellar",
    temperature: "balanced",
    theme: "dark",
    lodBand: "micro",
    reducedMotion: false,
    elapsedMilliseconds: DEFAULT_CALIBRATION.lod.crossfadeDurationMs,
  };
}

/** This creates view state for the supplied ids and does not carry graph-derived content. */
function state(input: VisualGraph, selectedId: string | null, focusedId: string | null) {
  return createVisualState(input, {
    selectedId,
    focusedId,
    camera: { x: 0, y: 0, angle: 0, ratio: 1, bounds: { x: [-1, 1], y: [-1, 1] } },
    cameraKind: ORTHOGRAPHIC,
    morphology: "neural",
    organization: "indra",
    palette: "interstellar",
    temperature: "balanced",
    theme: "dark",
    lodBand: "micro",
    reducedMotion: false,
  });
}

test("selection and focus consume the registered calibration parameters without changing graph structure", () => {
  const visualGraph = graph();
  const selectedNode = visualGraph.nodes[0];
  const focusedNode = visualGraph.nodes[1];
  const selectedEdge = visualGraph.edges[0];
  if (selectedNode === undefined || focusedNode === undefined || selectedEdge === undefined) {
    throw new TypeError("fixture requires two nodes and one edge");
  }
  const digest = semanticDigest(visualGraph);
  const base = buildRenderModel(visualGraph, options());
  const selected = buildRenderModel(visualGraph, options(), state(visualGraph, selectedNode.id, null));
  const focused = buildRenderModel(visualGraph, options(), state(visualGraph, null, focusedNode.id));
  const selectedEdgeModel = buildRenderModel(visualGraph, options(), state(visualGraph, selectedEdge.id, null));
  const scale = DEFAULT_CALIBRATION.morphology.stellar.opacityPermille;
  const emphasis = DEFAULT_CALIBRATION.selection.emphasisMultiplierPermille / scale;
  const focusDim = DEFAULT_CALIBRATION.selection.focusDimFactorPermille / scale;

  assert.equal(selected.graph.getNodeAttributes(selectedNode.id).size, base.graph.getNodeAttributes(selectedNode.id).size * emphasis);
  assert.equal(selected.graph.getNodeAttributes(selectedNode.id).haloRadiusPx, base.graph.getNodeAttributes(selectedNode.id).haloRadiusPx * emphasis);
  assert.equal(selectedEdgeModel.graph.getEdgeAttributes(selectedEdge.id).size, base.graph.getEdgeAttributes(selectedEdge.id).size * emphasis);
  assert.equal(parseColor(focused.graph.getNodeAttributes(focusedNode.id).color).a, parseColor(base.graph.getNodeAttributes(focusedNode.id).color).a);
  for (const id of visualGraph.nodes.map((node) => node.id).filter((id) => id !== focusedNode.id)) {
    assert.ok(
      Math.abs(
        parseColor(focused.graph.getNodeAttributes(id).color).a
        - (parseColor(base.graph.getNodeAttributes(id).color).a * focusDim),
      ) < Number.EPSILON,
    );
  }
  for (const id of visualGraph.edges.map((edge) => edge.id)) {
    assert.ok(
      Math.abs(
        parseColor(focused.graph.getEdgeAttributes(id).color).a
        - (parseColor(base.graph.getEdgeAttributes(id).color).a * focusDim),
      ) < Number.EPSILON,
    );
  }
  assert.deepEqual(selected.graph.nodes(), base.graph.nodes());
  assert.deepEqual(selected.graph.edges(), base.graph.edges());
  assert.deepEqual(focused.graph.nodes(), base.graph.nodes());
  assert.deepEqual(focused.graph.edges(), base.graph.edges());
  assert.deepEqual(selected.anchors, base.anchors);
  assert.deepEqual(focused.anchors, base.anchors);
  assert.equal(semanticDigest(visualGraph), digest);
});

test("selected provenance is the exact CAP-10-derived graph record, never a synthesised object", () => {
  const visualGraph = graph();
  const selectedNode = visualGraph.nodes[0];
  const selectedEdge = visualGraph.edges[0];
  if (selectedNode === undefined || selectedEdge === undefined) {
    throw new TypeError("fixture requires a node and an edge");
  }
  assert.strictEqual(
    selectedProvenanceForVisualState(visualGraph, state(visualGraph, selectedNode.id, null)),
    selectedNode.derived,
  );
  assert.strictEqual(
    selectedProvenanceForVisualState(visualGraph, state(visualGraph, selectedEdge.id, null)),
    selectedEdge.derived,
  );
  assert.equal(selectedProvenanceForVisualState(visualGraph, state(visualGraph, null, null)), null);
});
