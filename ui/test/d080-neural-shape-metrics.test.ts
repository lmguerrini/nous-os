import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import test from "node:test";
import { buildMorphologyGeometry, neuralJoinedRootWidthPx, neuralScreenWidthAt, neuralShoulderFraction } from "#engine/morphology-geometry.ts";
import { neuralEdgeEndOnSoma, somaOutlineRadiusAtAngle, somaDrawnElongation, NEURAL_EDGE_SOMA_OVERLAP_PX } from "#render-common/morphology-canvas.ts";
import { FILAMENT_FRAGMENT_SHADER } from "#render3f/filament-material.ts";
import { NODE_FRAGMENT_SHADER } from "#render3f/node-material.ts";

const cases = [
  { name: "leaf", bearings: [0], weights: [2] },
  { name: "spindle", bearings: [0, Math.PI], weights: [2, 1.8] },
  { name: "four-bundle hub", bearings: [0, 0.22, 1.4, 3.2], weights: [4, 3, 1.8, 1] },
  { name: "dense hub", bearings: Array.from({ length: 12 }, (_, index) => index * Math.PI / 6),
    weights: Array.from({ length: 12 }, (_, index) => index < 3 ? 4 : 1) },
] as const;

test("D-080 reference geometry: real-bundle silhouettes and joined monotone roots", () => {
  const metrics = cases.map(({ name, bearings, weights }) => {
    const nodes = [{ id: "soma", position: { x: 0, y: 0, z: 0 }, radius: 8 },
      ...bearings.map((angle, index) => ({ id: `branch-${index}`, position: {
        x: 100 * Math.cos(angle), y: 100 * Math.sin(angle), z: 0 }, radius: 4 }))];
    const edges = bearings.map((_, index) => ({ id: `edge-${index}`, source: "soma",
      target: `branch-${index}`, width: weights[index]! }));
    const first = buildMorphologyGeometry("neural", nodes, edges);
    const reversed = buildMorphologyGeometry("neural", nodes, [...edges].reverse());
    assert.deepEqual(first.nodes[0], reversed.nodes[0], `${name}: input order must not change shape`);
    const shape = first.nodes[0]!;
    const frame = { x: 0, y: 0, radius: 8, angle: Math.atan2(shape.axis.y, shape.axis.x),
      eccentricity: somaDrawnElongation(shape.eccentricity, shape.outline), harmonics: shape.outline };
    const radii = Array.from({ length: 360 }, (_, step) => somaOutlineRadiusAtAngle(frame, step * Math.PI / 180));
    const aspectRatio = Math.max(...radii) / Math.min(...radii);
    const bodyWidth = 1.5, span = 180;
    const rootWidth = neuralJoinedRootWidthPx(bodyWidth, frame.radius, shape.rootRatio!);
    const fitRootWidth = neuralJoinedRootWidthPx(bodyWidth, 3.5, shape.rootRatio!);
    const width = (t: number) => neuralScreenWidthAt(t, bodyWidth, frame.radius, frame.radius,
      [shape.rootRatio!, shape.rootRatio!], span, true);
    const shoulder = neuralShoulderFraction(span, frame.radius, bodyWidth);
    const samples = Array.from({ length: 41 }, (_, step) => width(shoulder * step / 40));
    for (let i = 1; i < samples.length; i++)
      assert.ok(samples[i]! <= samples[i - 1]! + 1e-9, `${name}: taper rises at ${i}`);
    const bearing = bearings[0]!;
    const join = neuralEdgeEndOnSoma(frame, { x: 100 * Math.cos(bearing), y: 100 * Math.sin(bearing) });
    const outline = somaOutlineRadiusAtAngle(frame, bearing);
    const overlapPx = outline - Math.hypot(join.x, join.y);
    const seamWidthDeltaPx = Math.abs(width(0) - rootWidth);
    assert.ok(overlapPx >= NEURAL_EDGE_SOMA_OVERLAP_PX - 1e-6, `${name}: root starts inside silhouette`);
    assert.ok(seamWidthDeltaPx < 1e-9, `${name}: root width steps at soma boundary`);
    assert.ok(aspectRatio >= 1.2 && aspectRatio <= 1.75, `${name}: aspect ${aspectRatio}`);
    assert.ok(rootWidth / bodyWidth >= 2.5 && rootWidth / bodyWidth <= 6.1, `${name}: root/shaft`);
    assert.ok(fitRootWidth / bodyWidth >= 2.5, `${name}: root remains readable at fit`);
    return { name, degree: bearings.length, somaAspectRatio: +aspectRatio.toFixed(3),
      rootToShaftRatio: +(rootWidth / bodyWidth).toFixed(3),
      fitRootToShaftRatio: +(fitRootWidth / bodyWidth).toFixed(3),
      rootToTipRatio: +(rootWidth / samples.at(-1)!).toFixed(3),
      taperMonotone: true, seamWidthDeltaPx, overlapPx: +overlapPx.toFixed(3) };
  });
  // D082-A-NEURAL BEGIN: P1 lines 69–76 require a rounded mouth at least as wide as the D-081 trunk.
  assert.match(FILAMENT_FRAGMENT_SHADER, /max\(max\(startAtJoin, ordinary \* abs\(v_neuralRootRatios\.x\)\)/);
  assert.match(FILAMENT_FRAGMENT_SHADER, /startRadius \* \(v_neuralRootRatios\.x < 0\.0 \? 1\.0 : 0\.9\)/);
  // D082-A-NEURAL END
  assert.match(NODE_FRAGMENT_SHADER, /irregularity \* 1\.6/);
  mkdirSync("dist/evidence", { recursive: true });
  writeFileSync("dist/evidence/d080-neural-shape-metrics.json", JSON.stringify({
    reference: "neuron-reference.png", target: { somaAspectRatio: [1.2, 1.75], rootToTipRatio: [2.5, 6.1],
      taperMonotone: true, seamWidthDeltaPx: 0, overlapPxMinimum: NEURAL_EDGE_SOMA_OVERLAP_PX },
    cases: metrics,
  }, null, 2) + "\n");
});
