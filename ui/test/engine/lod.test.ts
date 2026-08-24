import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { toVisualGraph } from "#adapter/projection.ts";
import { DEFAULT_CALIBRATION } from "#engine/calibration.ts";
import { layoutAnchors } from "#engine/layout.ts";
import {
  MACRO,
  MESO,
  MICRO,
  assertLodView,
  lodView,
  minimumResolvedMaterialDifference,
  resolvedMaterialDifference,
  resolveLodBand,
} from "#engine/lod.ts";

/** This reads one fixture graph and does not create LOD-only graph elements. */
function graph() {
  return toVisualGraph(JSON.parse(readFileSync(join(process.cwd(), "..", "fixtures", "synthetic", "projection", "discovery-at-question.json"), "utf8")) as unknown);
}

test("every LOD band preserves ids and world anchors", () => {
  const visualGraph = graph();
  const anchors = layoutAnchors(visualGraph);
  const bands = [MACRO, MESO, MICRO];
  assert.equal(bands.length, 3);
  for (const band of bands) {
    const view = lodView(visualGraph, anchors, band);
    assert.equal(view.nodeIds.length, visualGraph.nodes.length);
    assert.equal(view.edgeIds.length, visualGraph.edges.length);
    assert.equal(view.anchors.size, anchors.size);
    assert.deepEqual(view.nodeIds, visualGraph.nodes.map((node) => node.id));
    assert.deepEqual(view.edgeIds, visualGraph.edges.map((edge) => edge.id));
    assert.deepEqual(Object.fromEntries(view.anchors), Object.fromEntries(anchors));
    assertLodView(visualGraph, anchors, view);
  }
  assert.equal(bands.length, 3);
});

test("a decorative point fails the fixed-id LOD contract", () => {
  const visualGraph = graph();
  const view = lodView(visualGraph, layoutAnchors(visualGraph), MACRO);
  const decorative = { ...view, nodeIds: [...view.nodeIds, "decorative:point"] };
  assert.equal(decorative.nodeIds.length, visualGraph.nodes.length + 1);
  assert.throws(() => assertLodView(visualGraph, layoutAnchors(visualGraph), decorative), /node ids/);
});

test("hysteresis holds on both approaches to every boundary", () => {
  const thresholds = DEFAULT_CALIBRATION.lod.bandThresholds;
  const macroBoundary = thresholds[1];
  const microBoundary = thresholds[2];
  assert.ok(macroBoundary !== undefined);
  assert.ok(microBoundary !== undefined);
  const macroMargin = (macroBoundary * DEFAULT_CALIBRATION.lod.hysteresisMarginPermille) / 1000;
  const microMargin = (microBoundary * DEFAULT_CALIBRATION.lod.hysteresisMarginPermille) / 1000;
  assert.equal(resolveLodBand(macroBoundary + macroMargin, MACRO, DEFAULT_CALIBRATION), MESO);
  assert.equal(resolveLodBand(macroBoundary, MESO, DEFAULT_CALIBRATION), MESO);
  assert.equal(resolveLodBand(macroBoundary - macroMargin - (macroMargin / DEFAULT_CALIBRATION.lod.hysteresisMarginPermille), MESO, DEFAULT_CALIBRATION), MACRO);
  assert.equal(resolveLodBand(microBoundary + microMargin, MESO, DEFAULT_CALIBRATION), MICRO);
  assert.equal(resolveLodBand(microBoundary, MICRO, DEFAULT_CALIBRATION), MICRO);
  assert.equal(resolveLodBand(microBoundary - microMargin - (microMargin / DEFAULT_CALIBRATION.lod.hysteresisMarginPermille), MICRO, DEFAULT_CALIBRATION), MESO);
});

test("adjacent bands resolve materially different renderer state", () => {
  const macro = lodView(graph(), new Map(), MACRO).material;
  const meso = lodView(graph(), new Map(), MESO).material;
  const micro = lodView(graph(), new Map(), MICRO).material;
  const requiredMinimum = minimumResolvedMaterialDifference(DEFAULT_CALIBRATION);
  assert.equal(requiredMinimum, DEFAULT_CALIBRATION.lod.bandThresholds.length);
  assert.ok(resolvedMaterialDifference(macro, meso) >= requiredMinimum);
  assert.ok(resolvedMaterialDifference(meso, micro) >= requiredMinimum);
});
