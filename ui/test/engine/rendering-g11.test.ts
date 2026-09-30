import assert from "node:assert/strict";
import { test } from "node:test";
import { buildMorphologyGeometry } from "#engine/morphology-geometry.ts";
import { MORPHOLOGY_CONTRACT } from "#engine/morphology-contract.ts";
import {
  neuralEndpointDegrees,
  neuralRootAlphaFactor,
  neuralSomaTaperRatio,
  neuralTaperProfile,
} from "#render-common/morphology-canvas.ts";

const taper = MORPHOLOGY_CONTRACT.neural.edge.taper;
const [proximalBase] = taper as [number, number];

test("D-074 Neural taper keeps full root width at every degree and both ends", () => {
  for (const degree of [0, 1, 4, 20, 60]) {
    assert.equal(neuralSomaTaperRatio(proximalBase, degree), proximalBase);
    const profile = neuralTaperProfile(1.7, 1.2, taper, degree, degree);
    assert.ok(profile.start / profile.mid >= 2.4);
    assert.ok(profile.end / profile.mid >= 2.4);
    assert.equal(neuralRootAlphaFactor(degree), 1);
  }
});

test("G11 endpoint degrees: deterministic, world-space, and read the built geometry's somata", () => {
  const nodes = [
    { id: "hub", position: { x: 0, y: 0, z: 0 }, radius: 7 },
    { id: "a", position: { x: 120, y: 0, z: 0 }, radius: 3 },
    { id: "b", position: { x: -120, y: 40, z: 0 }, radius: 3 },
    { id: "c", position: { x: 0, y: -140, z: 0 }, radius: 3 },
  ];
  const edges = [
    { id: "ha", source: "hub", target: "a", width: 2 },
    { id: "hb", source: "hub", target: "b", width: 1.2 },
    { id: "hc", source: "hub", target: "c", width: 1.2 },
  ];
  const geometry = buildMorphologyGeometry("neural", nodes, edges);
  const degrees = neuralEndpointDegrees(geometry);
  assert.deepEqual(neuralEndpointDegrees(geometry), degrees, "memoised and deterministic");
  assert.ok(degrees.size > 0);
  // Every drawn dendrite end resolves to a degree, and the hub's ends read its higher degree
  // while the satellites' ends read their own lower one.
  const hubDegrees = new Set<number>();
  for (const part of geometry.drawnSegments) {
    const start = degrees.get(`${part.source.x}|${part.source.y}|${part.source.z}`) ?? -1;
    const end = degrees.get(`${part.target.x}|${part.target.y}|${part.target.z}`) ?? -1;
    assert.ok(start >= 1 && end >= 1, part.id);
    hubDegrees.add(Math.max(start, end));
  }
  assert.ok([...hubDegrees].some(degree => degree >= 3), "the hub end reads its degree");
});
