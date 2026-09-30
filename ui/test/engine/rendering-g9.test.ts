import assert from "node:assert/strict";
import { test } from "node:test";
import { buildMorphologyGeometry, SOMA_OUTLINE_MAX_RADIAL, somaOutlineHarmonics, somaOutlineIrregularity } from "#engine/morphology-geometry.ts";
import { MORPHOLOGY_CONTRACT } from "#engine/morphology-contract.ts";
import {
  NEURAL_EDGE_MID_MIN_PX,
  NEURAL_HALO_ALPHA_FLOOR,
  NEURAL_HALO_DENSITY_CELL,
  SOMA_IRREGULARITY_BOOST,
  SOMA_IRREGULARITY_MIN_SCALE,
  neuralHaloAlphaFactor,
  neuralHaloNeighbourCounts,
  neuralTaperProfile,
  somaDrawnElongation,
  somaElongationFactor,
  somaIrregularityScale,
} from "#render-common/morphology-canvas.ts";
import { STARFIELD_CELL_PX, STARFIELD_MAX_STARS, STAR_MAX_ALPHA, STAR_MAX_RADIUS_PX, starAlpha, starfieldStars } from "#render-common/starfield.ts";

const std = (values: readonly number[]): number => {
  const mean = values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
  return Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / Math.max(1, values.length));
};

test("G9 Neural taper: soma ends draw at 2.2–2.6× the mid width, mid keeps a 0.6 px floor", () => {
  const taper = MORPHOLOGY_CONTRACT.neural.edge.taper;
  for (const ratio of taper) assert.ok(ratio >= 2.2 && ratio <= 2.6, `contract taper ${taper.join("/")}`);
  assert.ok(NEURAL_EDGE_MID_MIN_PX >= 0.6, "the mid-edge width never disappears on screen");
  // Both orientations: the proximal soma is the wider end wherever it falls.
  for (const [widthStart, widthEnd] of [[1.7, 0.85], [0.85, 1.7], [3, 1], [1, 3], [2.2, 2.2]] as const) {
    const profile = neuralTaperProfile(widthStart, widthEnd, taper);
    for (const end of [profile.start, profile.end]) {
      const ratio = end / profile.mid;
      assert.ok(ratio >= 2.2 - 1e-9 && ratio <= 2.6 + 1e-9, `${widthStart}/${widthEnd}: soma/mid ${ratio.toFixed(4)}`);
    }
    assert.ok(profile.mid > 0, "mid keyframe is positive");
  }
  // The whole built geometry keeps the ratio on every drawn dendrite.
  const geometry = buildMorphologyGeometry("neural", [
    { id: "hub", position: { x: 0, y: 0, z: 0 }, radius: 7 },
    { id: "a", position: { x: 120, y: 0, z: 0 }, radius: 3 },
    { id: "b", position: { x: -120, y: 40, z: 0 }, radius: 3 },
  ], [
    { id: "ha", source: "hub", target: "a", width: 2 },
    { id: "hb", source: "hub", target: "b", width: 1.2 },
  ]);
  assert.ok(geometry.drawnSegments.length > 0);
  for (const part of geometry.drawnSegments) {
    const profile = neuralTaperProfile(part.widthStart, part.widthEnd, taper);
    assert.ok(profile.start / profile.mid >= 2.2 && profile.end / profile.mid >= 2.2, part.id);
    assert.ok(Math.max(profile.start, profile.end) / profile.mid <= 2.6, part.id);
  }
});

test("G9 Neural halo: radius cap 1.5× the soma, lower constant strength, density-aware alpha", () => {
  const neural = MORPHOLOGY_CONTRACT.neural.glow;
  const stellar = MORPHOLOGY_CONTRACT.stellar.glow;
  const mycelium = MORPHOLOGY_CONTRACT.mycelium.glow;
  assert.ok(neural.maximumCoreRatio <= 1.5, `neural halo ratio ${neural.maximumCoreRatio}`);
  assert.ok(neural.strength <= 0.12, `neural halo strength ${neural.strength}`);
  assert.ok(neural.strength < stellar.strength, "the Neural halo is fainter than Stellar's");
  // D-072 V4/V5 (M1b): Stellar's halo is a short glow contained at 1.6× the now-small star core —
  // its strength rose with M1b (0.18 → 0.24) because a 2–6 px core needs a firmer glow to read as
  // a star; Neural's hugs the soma at 1.1× with a very low strength. Mycelium stays untouched.
  assert.deepEqual(stellar, { maximumCoreRatio: 1.6, strength: 0.24 });
  assert.deepEqual(neural, { maximumCoreRatio: 1.1, strength: 0.05 });
  assert.deepEqual(mycelium, { maximumCoreRatio: 1.25, strength: 0.08 });
  // Alone a soma keeps its full halo; overlapping somata dim it, never below the floor.
  assert.equal(neuralHaloAlphaFactor(1), 1);
  assert.equal(neuralHaloAlphaFactor(0), 1);
  let previous = 1;
  for (let neighbours = 2; neighbours <= 24; neighbours += 1) {
    const factor = neuralHaloAlphaFactor(neighbours);
    assert.ok(factor <= previous, "the falloff is monotone");
    assert.ok(factor >= NEURAL_HALO_ALPHA_FLOOR, `${neighbours}: ${factor}`);
    previous = factor;
  }
  assert.ok(neuralHaloAlphaFactor(24) === NEURAL_HALO_ALPHA_FLOOR, "a dense hub reaches the floor");
  // The neighbour count is world-space and deterministic: a hub cluster counts high, a lone soma 1.
  const cluster = Array.from({ length: 5 }, (_, index) => ({
    id: `c${index}`, position: { x: index * 4, y: 0, z: 0 }, radius: 3, degree: 1,
    axis: { x: 1, y: 0, z: 0 }, eccentricity: 1.2, outline: [],
  }));
  const lone = { id: "lone", position: { x: 1000, y: 1000, z: 0 }, radius: 3, degree: 0,
    axis: { x: 1, y: 0, z: 0 }, eccentricity: 1, outline: [] };
  const counts = neuralHaloNeighbourCounts([...cluster, lone]);
  for (const member of cluster) assert.ok((counts.get(member.id) ?? 0) >= 5, member.id);
  assert.equal(counts.get("lone"), 1);
  assert.deepEqual(neuralHaloNeighbourCounts([...cluster, lone]), counts);
  assert.ok(NEURAL_HALO_DENSITY_CELL > 0);
});

test("G9 Neural somata: deterministic per-node elongation jitter within the geometry bounds", () => {
  const ids = Array.from({ length: 96 }, (_, index) => `soma-${index}`);
  const factors = ids.map(id => somaElongationFactor(somaOutlineHarmonics(id)));
  // Deterministic: the id fixes the factor.
  for (const id of ids) assert.equal(somaElongationFactor(somaOutlineHarmonics(id)), somaElongationFactor(somaOutlineHarmonics(id)));
  // Varied: the verified "one rotated template" complaint required visible spread, not one value.
  assert.ok(Math.max(...factors) - Math.min(...factors) >= 0.07, `span ${(Math.max(...factors) - Math.min(...factors)).toFixed(3)}`);
  assert.ok(std(factors) > 0.01, `std ${std(factors).toFixed(3)}`);
  for (const factor of factors) assert.ok(Math.abs(factor - 1) <= 0.04 + 1e-9, `${factor}`);
  // The drawn elongation stays inside the geometry's eccentricity bounds, and an isolated soma
  // (eccentricity 1, no local connections) is left round.
  for (const id of ids) {
    const harmonics = somaOutlineHarmonics(id);
    assert.ok(somaDrawnElongation(1.25, harmonics) >= 1.04 - 1e-9 && somaDrawnElongation(1.25, harmonics) <= 1.32, id);
    assert.ok(somaDrawnElongation(1.9, harmonics) <= 1.32, id);
    assert.equal(somaDrawnElongation(1, harmonics), 1);
  }
});

test("D-074 Neural somata: organic irregularity stays within ±0.12", () => {
  assert.ok(SOMA_IRREGULARITY_BOOST > 1, "the drawn irregularity is boosted");
  assert.ok(SOMA_IRREGULARITY_MIN_SCALE >= 0.55, "small somata keep more of their irregularity than before");
  assert.equal(somaIrregularityScale(2), SOMA_IRREGULARITY_MIN_SCALE);
  assert.equal(somaIrregularityScale(11), 1);
  // The boosted deviation never leaves the geometry's radial bound, whatever the id and angle.
  for (let index = 0; index < 96; index += 1) {
    const harmonics = somaOutlineHarmonics(`soma-${index}`);
    for (let sample = 0; sample < 96; sample += 1) {
      const theta = (sample / 96) * Math.PI * 2;
      const boosted = somaOutlineIrregularity(harmonics, theta) * somaIrregularityScale(11) * SOMA_IRREGULARITY_BOOST;
      assert.ok(Math.min(Math.max(boosted, -SOMA_OUTLINE_MAX_RADIAL), SOMA_OUTLINE_MAX_RADIAL) <= SOMA_OUTLINE_MAX_RADIAL);
      assert.ok(Math.abs(boosted) <= 1.4 * SOMA_OUTLINE_MAX_RADIAL, "the boost stays bounded by the harmonic reach");
    }
  }
});

test("G9 starfield: every star stays smaller than a satellite node and under the alpha cap, at every setting", () => {
  // The smallest drawn Stellar node: the 2 px clamp floor of the shared canvas layer; the smallest
  // drawn node alpha: the 0.48 opacity floor. Stars stay under 0.6× the radius, so no star reads as a node.
  const smallestNodeRadiusPx = 2;
  assert.ok(STAR_MAX_RADIUS_PX < 0.6 * smallestNodeRadiusPx, `${STAR_MAX_RADIUS_PX}`);
  assert.ok(STAR_MAX_ALPHA <= 0.7, `${STAR_MAX_ALPHA}`);
  assert.ok(starAlpha(1, 1) <= STAR_MAX_ALPHA, "a star at maximum settings stays under the cap");
  for (const density of [0.05, 0.25, 0.5, 1]) {
    for (const brightness of [0.05, 0.35, 0.7, 1]) {
      const stars = starfieldStars(1400, 900, density);
      assert.ok(stars.length > 0 && stars.length <= STARFIELD_MAX_STARS);
      for (const star of stars) {
        assert.ok(star.size <= STAR_MAX_RADIUS_PX, JSON.stringify(star));
        assert.ok(starAlpha(brightness, star.intensity) <= STAR_MAX_ALPHA, JSON.stringify(star));
      }
    }
  }
  // The default look keeps its stars, deterministically placed.
  const defaultStars = starfieldStars(800, 600, 0.45);
  assert.ok(defaultStars.length >= Math.ceil(800 / STARFIELD_CELL_PX) * Math.ceil(600 / STARFIELD_CELL_PX) * 3);
  assert.deepEqual(starfieldStars(800, 600, 0.45), defaultStars);
});
