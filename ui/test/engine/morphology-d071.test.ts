import assert from "node:assert/strict";
import { test } from "node:test";
import { buildMorphologyGeometry, MYCELIUM_AMPLITUDE_CAP_PX, NEURAL_TAPER, SOMA_OUTLINE_MAX_RADIAL, somaOutlineHarmonics, somaOutlineIrregularity } from "#engine/morphology-geometry.ts";
import type { MorphologySegment } from "#engine/morphology-geometry.ts";
import { starfieldStars, drawStarfield, STARFIELD_MAX_STARS } from "#render-common/starfield.ts";
import { STARFIELD_CELL_PX, STAR_MAX_RADIUS_PX, starAlpha, starfieldCellSize } from "#render-common/starfield.ts";
import { DEFAULT_APPEARANCE } from "#engine/presentation-options.ts";
import { MORPHOLOGY_CONTRACT } from "#engine/morphology-contract.ts";
import { stellarStarCoreRadiusPx } from "#render-common/morphology-canvas.ts";

const std = (values: readonly number[]): number => {
  const mean = values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
  return Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / Math.max(1, values.length));
};
const span = (a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
/** Maximum perpendicular offset of a segment's samples away from its chord. */
const maxOffset = (part: MorphologySegment): number => {
  const a = part.samples[0]!, b = part.samples.at(-1)!;
  const dx = b.x - a.x, dy = b.y - a.y, length = Math.hypot(dx, dy) || 1;
  return Math.max(...part.samples.map(p => Math.abs(((p.x - a.x) * -dy + (p.y - a.y) * dx) / length)));
};
const orientation = (a: { x: number; y: number }, b: { x: number; y: number }, c: { x: number; y: number }) =>
  Math.sign((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x));
const segmentsCross = (p: { x: number; y: number }, q: { x: number; y: number }, r: { x: number; y: number }, s: { x: number; y: number }) =>
  orientation(p, q, r) !== orientation(p, q, s) && orientation(r, s, p) !== orientation(r, s, q);
const selfIntersects = (samples: readonly { x: number; y: number }[]): boolean => {
  for (let i = 0; i < samples.length - 1; i++) for (let j = i + 2; j < samples.length - 1; j++)
    if (segmentsCross(samples[i]!, samples[i + 1]!, samples[j]!, samples[j + 1]!)) return true;
  return false;
};

test("D-071 starfield is deterministic and zero density yields no stars", () => {
  assert.equal(starfieldStars(800, 600, 0).length, 0);
  const low = starfieldStars(800, 600, 0.25);
  const high = starfieldStars(800, 600, 1);
  assert.ok(low.length > 0);
  assert.ok(high.length > low.length);
  assert.ok(high.length <= STARFIELD_MAX_STARS);
  assert.deepEqual(starfieldStars(800, 600, 0.25), low);
  for (const star of low) {
    assert.ok(star.u >= 0 && star.u < 1 && star.v >= 0 && star.v < 1, JSON.stringify(star));
    assert.ok(star.intensity > 0 && star.intensity <= 1);
  }
  const calls: [number, number, number, number][] = [];
  const context = { fillStyle: "", fillRect: (x: number, y: number, w: number, h: number) => calls.push([x, y, w, h]) } as unknown as CanvasRenderingContext2D;
  drawStarfield(context, 800, 600, 0, 1);
  assert.equal(calls.length, 0);
  drawStarfield(context, 800, 600, 0.25, 0);
  assert.equal(calls.length, 0);
  drawStarfield(context, 800, 600, 0.25, 0.5);
  assert.ok(calls.length > 0);
});

test("D-074 Stellar base covers every 48 px canvas cell with stars smaller than graph nodes", () => {
  const width = 1600, height = 900;
  const stars = starfieldStars(width, height, DEFAULT_APPEARANCE.starfieldDensity);
  const columns = Math.ceil(width / STARFIELD_CELL_PX), rows = Math.ceil(height / STARFIELD_CELL_PX);
  const cells = new Uint16Array(columns * rows);
  for (const star of stars) {
    const column = Math.floor(star.u * width / STARFIELD_CELL_PX);
    const row = Math.floor(star.v * height / STARFIELD_CELL_PX);
    cells[row * columns + column]!++;
    assert.ok(star.size <= STAR_MAX_RADIUS_PX && star.size < 0.6 * 2);
    assert.ok(starAlpha(DEFAULT_APPEARANCE.starfieldBrightness, star.intensity) >= 0.4);
  }
  assert.equal(stars.length, 1292);
  assert.ok(cells.every(count => count >= 2), "no 48×48 CSS px cell is empty");
  assert.equal(stars[0] && "id" in stars[0], false, "decorative stars carry no graph identity");
  const largeWidth = 7680, largeHeight = 4320;
  const largeCell = starfieldCellSize(largeWidth, largeHeight);
  const largeColumns = Math.ceil(largeWidth / largeCell), largeRows = Math.ceil(largeHeight / largeCell);
  const largeCells = new Uint16Array(largeColumns * largeRows);
  for (const star of starfieldStars(largeWidth, largeHeight, DEFAULT_APPEARANCE.starfieldDensity)) {
    const column = Math.floor(star.u * largeWidth / largeCell);
    const row = Math.floor(star.v * largeHeight / largeCell);
    largeCells[row * largeColumns + column]!++;
  }
  assert.ok(largeCell > STARFIELD_CELL_PX);
  assert.ok(largeCells.every(count => count >= 2), "large canvases retain whole-field coverage under the cap");
});

test("D-074 default product radii are smaller, ordered by importance, and retain the node slider range", () => {
  assert.equal(DEFAULT_APPEARANCE.nodeScale, 1);
  const base = [3, 5, 9, 18];
  const radii = (morphology: "stellar" | "neural" | "mycelium", slider: number) => base.map(value => {
    const contract = MORPHOLOGY_CONTRACT[morphology];
    const basis = Math.max(morphology === "mycelium" ? 1.3 : 2,
      Math.min(contract.node.maxRadiusPx, value * slider * contract.node.scale));
    return morphology === "stellar" ? stellarStarCoreRadiusPx(basis, 1) : basis;
  });
  for (const morphology of ["stellar", "neural", "mycelium"] as const) {
    const defaults = radii(morphology, DEFAULT_APPEARANCE.nodeScale);
    assert.ok(defaults.every((value, i) => i === 0 || value >= defaults[i - 1]!));
    assert.ok(defaults.at(-1)! <= (morphology === "stellar" ? 5 : morphology === "neural" ? 9 : 4.5));
    assert.ok(radii(morphology, 2.5)[1]! > radii(morphology, 0.4)[1]!);
  }
});

test("D-071 Neural somata differ: eccentricity spread and bounded outline irregularity", () => {
  const nodes = [
    { id: "hub", position: { x: 0, y: 0, z: 0 }, radius: 7 },
    { id: "e", position: { x: 100, y: 0, z: 0 }, radius: 3 },
    { id: "w", position: { x: -100, y: 0, z: 0 }, radius: 3 },
    { id: "n", position: { x: 0, y: 100, z: 0 }, radius: 3 },
    { id: "s", position: { x: 0, y: -100, z: 0 }, radius: 3 },
    { id: "tail", position: { x: 200, y: 0, z: 0 }, radius: 2 },
  ];
  const edges = [
    { id: "he", source: "hub", target: "e", width: 2 },
    { id: "hw", source: "hub", target: "w", width: 2 },
    { id: "hn", source: "hub", target: "n", width: 2 },
    { id: "hs", source: "hub", target: "s", width: 2 },
    { id: "et", source: "e", target: "tail", width: 2 },
  ];
  const geometry = buildMorphologyGeometry("neural", nodes, edges);
  assert.ok(std(geometry.nodes.map(node => node.eccentricity)) > 0.1, JSON.stringify(geometry.nodes.map(node => node.eccentricity)));
  for (const node of geometry.nodes) {
    assert.equal(node.outline.length, 3);
    for (let sample = 0; sample < 64; sample++) {
      const theta = (sample / 64) * Math.PI * 2;
      assert.ok(Math.abs(somaOutlineIrregularity(node.outline, theta)) <= SOMA_OUTLINE_MAX_RADIAL);
    }
  }
  const fingerprints = new Set(nodes.map(node => somaOutlineHarmonics(node.id).map(harmonic => harmonic.amplitude.toFixed(4)).join(":")));
  assert.ok(fingerprints.size > 1);
});

test("D-074 Neural soma stays compact with bounded organic outline", () => {
  const collinear = buildMorphologyGeometry("neural", [
    { id: "hub", position: { x: 0, y: 0, z: 0 }, radius: 11 },
    { id: "e", position: { x: 100, y: 0, z: 0 }, radius: 4 },
    { id: "w", position: { x: -100, y: 0, z: 0 }, radius: 4 },
  ], [
    { id: "he", source: "hub", target: "e", width: 2 },
    { id: "hw", source: "hub", target: "w", width: 2 },
  ]);
  assert.ok(collinear.nodes[0]!.eccentricity >= 1.25, `collinear eccentricity ${collinear.nodes[0]!.eccentricity}`);
  assert.ok(collinear.nodes[0]!.eccentricity <= 1.32);
  // Isolated somata stay round: no local connection to orient them.
  const isolated = buildMorphologyGeometry("neural", [{ id: "iso", position: { x: 0, y: 0, z: 0 }, radius: 6 }], []).nodes[0]!;
  assert.equal(isolated.eccentricity, 1);
  assert.equal(SOMA_OUTLINE_MAX_RADIAL, 0.12);
  // The per-node harmonics can actually approach the bound (not just a tiny, invisible ripple).
  const harmonics = somaOutlineHarmonics("hub");
  const maxReach = harmonics.reduce((sum, harmonic) => sum + harmonic.amplitude, 0);
  assert.ok(maxReach > 0.05 && maxReach <= 0.12, `harmonic reach ${maxReach.toFixed(3)}`);
});

test("D-071 Neural taper: soma end is at least twice the mid-edge width", () => {
  const geometry = buildMorphologyGeometry("neural", [
    { id: "hub", position: { x: 0, y: 0, z: 0 }, radius: 7 },
    { id: "a", position: { x: 120, y: 0, z: 0 }, radius: 3 },
  ], [{ id: "ha", source: "hub", target: "a", width: 2 }]);
  for (const part of geometry.drawnSegments) {
    assert.ok(Math.max(part.widthStart, part.widthEnd) >= 2 * part.widthMid, JSON.stringify(part));
    assert.ok(part.widthMid < part.widthStart && part.widthMid < part.widthEnd);
  }
  assert.equal(NEURAL_TAPER.proximal >= 2 * NEURAL_TAPER.mid, true);
});

test("D-071 Mycelium amplitude is bounded by edge length and a fixed pixel cap", () => {
  const nodes = [
    { id: "a", position: { x: 0, y: 0, z: 0 }, radius: 3 },
    { id: "b", position: { x: 220, y: 0, z: 0 }, radius: 3 },
    { id: "c", position: { x: 440, y: 0, z: 0 }, radius: 3 },
    { id: "d", position: { x: 80, y: 160, z: 0 }, radius: 3 },
  ];
  const edges = [
    { id: "ab", source: "a", target: "b", width: 2 },
    { id: "bc", source: "b", target: "c", width: 2 },
    { id: "ad", source: "a", target: "d", width: 2 },
  ];
  const geometry = buildMorphologyGeometry("mycelium", nodes, edges);
  assert.ok(geometry.drawnSegments.length > 0);
  for (const part of geometry.drawnSegments) {
    const chord = span(part.source, part.target);
    if (chord < 1) continue;
    const offset = maxOffset(part);
    assert.ok(offset <= 0.06 * chord + 1e-6, `${part.id} offset ${offset} vs ${0.06 * chord}`);
    assert.ok(offset <= MYCELIUM_AMPLITUDE_CAP_PX + 1e-6, `${part.id} offset ${offset} vs cap`);
  }
});

test("D-071 Mycelium edges do not self-intersect on synthetic edges", () => {
  const nodes = Array.from({ length: 8 }, (_, index) => ({
    id: `n${index}`, position: { x: index * 150, y: index % 2 === 0 ? 0 : 90, z: 0 }, radius: 3,
  }));
  const edges = nodes.slice(0, -1).map((node, index) => ({ id: `e${index}`, source: node.id, target: nodes[index + 1]!.id, width: 2 }));
  const geometry = buildMorphologyGeometry("mycelium", nodes, edges);
  for (const part of geometry.drawnSegments) {
    const points = part.samples.map(point => ({ x: point.x, y: point.y }));
    assert.equal(selfIntersects(points), false, `${part.id} self-intersects`);
  }
});

test("D-074 Mycelium branches at real graph junctions", () => {
  const nodes = [
    { id: "a", position: { x: 100, y: 0, z: 0 }, radius: 3 },
    { id: "b", position: { x: -50, y: 87, z: 0 }, radius: 3 },
    { id: "c", position: { x: -50, y: -87, z: 0 }, radius: 3 },
  ];
  const edges = [
    { id: "ab", source: "a", target: "b", width: 2 },
    { id: "ac", source: "a", target: "c", width: 2 },
    { id: "bc", source: "b", target: "c", width: 2 },
    { id: "ad", source: "a", target: "d", width: 2 },
  ];
  nodes.push({ id: "d", position: { x: 140, y: 80, z: 0 }, radius: 3 });
  const colony = [{ id: "col", members: nodes.map(node => node.id), center: { x: 0, y: 0, z: 0 } }];
  const geometry = buildMorphologyGeometry("mycelium", nodes, edges, colony);
  assert.deepEqual(geometry.branchPoints, [nodes[0]!.position]);
  assert.ok(geometry.drawnSegments.every(part => part.sharedKey === null));
});
