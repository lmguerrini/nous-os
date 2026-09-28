import assert from "node:assert/strict";
import { test } from "node:test";
import { buildMorphologyGeometry } from "#engine/morphology-geometry.ts";
import { MORPHOLOGY_CONTRACT } from "#engine/morphology-contract.ts";
import {
  NEURAL_ROOT_ALPHA_FLOOR,
  NEURAL_TAPER_DEGREE_FULL,
  NEURAL_TAPER_RATIO_FLOOR,
  neuralEndpointDegrees,
  neuralRootAlphaFactor,
  neuralSomaTaperRatio,
  neuralTaperProfile,
} from "#render-common/morphology-canvas.ts";

const taper = MORPHOLOGY_CONTRACT.neural.edge.taper;
const [proximalBase, distalBase] = taper as [number, number];

test("G11 degree-scaled taper ratio: full up to degree 4, floored at 1.3, monotone", () => {
  for (const degree of [0, 1, 2, 3, 4])
    assert.equal(neuralSomaTaperRatio(proximalBase, degree), proximalBase, `degree ${degree} keeps the full ratio`);
  let previous = proximalBase;
  for (let degree = NEURAL_TAPER_DEGREE_FULL; degree <= 64; degree += 1) {
    const ratio = neuralSomaTaperRatio(proximalBase, degree);
    assert.ok(ratio <= previous + 1e-12, `degree ${degree}: the ratio never rises (${ratio} > ${previous})`);
    assert.ok(ratio >= NEURAL_TAPER_RATIO_FLOOR - 1e-9, `degree ${degree}: ratio ${ratio} under the floor`);
    previous = ratio;
  }
  // The audit's hubs (20–60 edges) sit at the floor, and the formula matches 2.4/√(degree/4).
  for (const degree of [20, 40, 60]) {
    assert.ok(Math.abs(neuralSomaTaperRatio(proximalBase, degree) - NEURAL_TAPER_RATIO_FLOOR) < 1e-9, `degree ${degree}`);
    assert.ok(neuralSomaTaperRatio(2.6, degree) === NEURAL_TAPER_RATIO_FLOOR, "any base above the floor lands on it");
  }
  assert.ok(Math.abs(neuralSomaTaperRatio(proximalBase, 9) - proximalBase / 1.5) < 1e-9, "degree 9: 2.4/√(9/4)");
});

test("G11 taper profile: each soma end keeps a visible taper whatever its degree", () => {
  // Low-degree ends keep the G9 contract ratios untouched.
  const plain = neuralTaperProfile(1.7, 0.85, taper);
  assert.ok(Math.abs(plain.start / plain.mid - Math.max(proximalBase, distalBase)) < 1e-9);
  assert.ok(Math.abs(plain.end / plain.mid - Math.min(proximalBase, distalBase)) < 1e-9);
  // A high-degree start soma caps only its own end; the other end keeps its own degree's ratio.
  for (const degree of [5, 9, 14, 30, 60]) {
    const profile = neuralTaperProfile(1.7, 0.85, taper, degree, 2);
    const startRatio = profile.start / profile.mid;
    const expected = neuralSomaTaperRatio(Math.max(proximalBase, distalBase), degree);
    assert.ok(Math.abs(startRatio - expected) < 1e-9, `degree ${degree}: start ratio ${startRatio} ≠ ${expected}`);
    assert.ok(startRatio >= NEURAL_TAPER_RATIO_FLOOR - 1e-9, "the taper never disappears at a hub");
    assert.ok(Math.abs(profile.end / profile.mid - Math.min(proximalBase, distalBase)) < 1e-9, "the low-degree end is untouched");
  }
  // Both ends hub-scale independently.
  const hub = neuralTaperProfile(1.7, 0.85, taper, 30, 40);
  assert.ok(Math.abs(hub.start / hub.mid - NEURAL_TAPER_RATIO_FLOOR) < 1e-9);
  assert.ok(Math.abs(hub.end / hub.mid - NEURAL_TAPER_RATIO_FLOOR) < 1e-9);
  assert.ok(hub.mid > 0);
});

test("G11 root alpha: dims slightly near a high-degree soma, never below the floor, monotone", () => {
  for (const degree of [0, 1, 4]) assert.equal(neuralRootAlphaFactor(degree), 1);
  let previous = 1;
  for (let degree = NEURAL_TAPER_DEGREE_FULL; degree <= 64; degree += 1) {
    const factor = neuralRootAlphaFactor(degree);
    assert.ok(factor <= previous + 1e-12, "monotone");
    assert.ok(factor >= NEURAL_ROOT_ALPHA_FLOOR - 1e-9, `degree ${degree}: ${factor}`);
    previous = factor;
  }
  assert.equal(neuralRootAlphaFactor(8), NEURAL_ROOT_ALPHA_FLOOR);
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
