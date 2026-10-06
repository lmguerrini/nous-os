import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
// D084-W2-NEURAL: organic soma–axon continuity. Every test here fails on
// the base (D-082) code: its expectations are exactly the defect that was rejected
// (free spindle elongation, long narrow teardrops, a mouth narrower or wider than the
// body it leaves, and cosmetic filaments faking relations the graph does not draw).
import { buildMorphologyGeometry, NEURAL_LEAF_BODY_SCALE, NEURAL_PROFILE_GLSL, NEURAL_PROFILE_TABLE, NEURAL_ROOT_ANCHOR_RADII, NEURAL_ROOT_FILLET_LENGTH_RADII, NEURAL_ROOT_FILLET_RADII, NEURAL_ROOT_LENGTH_RADII, NEURAL_ROOT_MOUTH_RADII, neuralEndpointBodyScale, neuralProfileTableAt, neuralRootCompactnessScale, neuralRootLengthPx,
  neuralRootProfileAt, neuralRootProfileAtLength, neuralVisibleRootLengthPx } from "#engine/morphology-geometry.ts";
import { MORPHOLOGY_CONTRACT } from "#engine/morphology-contract.ts";
import { DEFAULT_APPEARANCE } from "#engine/presentation-options.ts";
import { NEURAL_EDGE_SOMA_OVERLAP_PX, neuralLeafRootWidthPx, neuralRootInsideSoma, neuralSomaFrames,
  somaOutlineRadiusAtAngle, type MorphologyCanvasStyle, type NeuralSomaFrame } from "#render-common/morphology-canvas.ts";
import { FILAMENT_FRAGMENT_SHADER, FILAMENT_VERTEX_SHADER, neuralRootCompactScaleQA } from "#render3f/filament-material.ts";
import { FILAMENT_NEURAL_PROFILE_TABLE_3D } from "#render3f/filament-material.ts";
import { buildNodeBuffers, buildSceneBuffers } from "#render3f/buffers.ts";
import { buildScene } from "#scene/build.ts";
import { sceneFixtureGraph, sceneVisualState } from "#test-scene/support.ts";

const position = (x: number, y: number) => ({ x, y, z: 0 });
const bearingSets = {
  // One strong bundle plus two single spokes — the fixture whose base silhouette was a
  // free spindle along the bundle bisector with eccentricity >= 1.24.
  bundled: [0, 0.1, -0.1, 0.2, -0.2, Math.PI / 2, -Math.PI / 2],
  dense: Array.from({ length: 12 }, (_, index) => index * Math.PI / 6),
  pair: [Math.PI / 3, -Math.PI / 3],
} as const;

function hubFixture(bearings: readonly number[], radius = 8, span = 100) {
  const nodes = [{ id: "soma", position: position(0, 0), radius },
    ...bearings.map((angle, index) => ({ id: `end-${index}`,
      position: position(span * Math.cos(angle), span * Math.sin(angle)), radius: 4 }))];
  const edges = bearings.map((_, index) => ({ id: `edge-${index}`, source: "soma",
    target: `end-${index}`, width: index < 5 ? 2 : 1 }));
  return { nodes, edges, bearings, geometry: buildMorphologyGeometry("neural", nodes, edges) };
}

function frameOf(geometry: ReturnType<typeof buildMorphologyGeometry>, style: MorphologyCanvasStyle,
  id = "soma"): NeuralSomaFrame {
  return neuralSomaFrames(geometry, point => ({ x: point.x, y: point.y, scale: 1 }), style,
    MORPHOLOGY_CONTRACT.neural, DEFAULT_APPEARANCE).get(id)!;
}

const styleOf = (nodes: readonly { id: string }[], edges: readonly { id: string }[]): MorphologyCanvasStyle => ({
  fieldColor: "rgb(0, 0, 0)",
  nodes: new Map(nodes.map(node => [node.id, { color: "rgb(255, 255, 255)", radiusPx: 8 }])),
  edges: new Map(edges.map(edge => [edge.id, { color: "rgb(102, 102, 102)" }])),
});

// D084-W2-NEURAL-R4 BEGIN: these derivative and uniform checks fail on the
// earlier ball/wedge union and on independent shader-local taper formulas.
test("the 0.35R concave fillet is tangent to a round soma and a 0.45R process", () => {
  const h = (s: number) => neuralProfileTableAt(s).halfWidthRadii;
  const step = 1e-4;
  const circle = (x: number) => Math.sqrt(1 - x * x);
  const bodySlope = (circle(NEURAL_ROOT_ANCHOR_RADII) - circle(NEURAL_ROOT_ANCHOR_RADII - step)) / step;
  const filletSlope = (h(step) - h(0)) / step;
  assert.ok(Math.abs(bodySlope - filletSlope) < 0.02, `body ${bodySlope}, fillet ${filletSlope}`);
  const end = NEURAL_ROOT_FILLET_LENGTH_RADII;
  assert.ok(Math.abs((h(end) - h(end - step)) / step) < 0.02, "horizontal process tangency");
  assert.ok(Math.abs(h(end) - NEURAL_ROOT_MOUTH_RADII) < 1e-6);
  const union = (x: number) => Math.max(x < 1 ? circle(x) : 0,
    h(Math.max(0, x - NEURAL_ROOT_ANCHOR_RADII)));
  const leftSlope = (union(NEURAL_ROOT_ANCHOR_RADII) - union(NEURAL_ROOT_ANCHOR_RADII - step)) / step;
  const rightSlope = (union(NEURAL_ROOT_ANCHOR_RADII + step) - union(NEURAL_ROOT_ANCHOR_RADII)) / step;
  assert.ok(Math.abs(leftSlope - rightSlope) < 0.02, "the visible union has no corner");
  const points = Array.from({ length: 23 }, (_, i) => ({ x: end * (i + 1) / 24, y: h(end * (i + 1) / 24) }));
  const slopes = points.slice(1).map((point, i) =>
    (point.y - points[i]!.y) / (point.x - points[i]!.x));
  for (let i = 1; i < slopes.length; i++)
    assert.ok(Math.abs(slopes[i]! - slopes[i - 1]!) < 0.16,
      `bounded tangent change at sample ${i}: ${slopes[i]! - slopes[i - 1]!}`);
  for (let i = 1; i < points.length - 1; i++) {
    const a = points[i - 1]!, b = points[i]!, c = points[i + 1]!;
    const ab = Math.hypot(b.x - a.x, b.y - a.y);
    const bc = Math.hypot(c.x - b.x, c.y - b.y);
    const ca = Math.hypot(a.x - c.x, a.y - c.y);
    const twiceArea = Math.abs((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x));
    const radius = ab * bc * ca / Math.max(2 * twiceArea, 1e-12);
    assert.ok(radius >= 0.3 && radius <= 0.42, `fillet radius ${radius} at ${i}`);
  }
  assert.equal(NEURAL_ROOT_FILLET_RADII, 0.35);
  for (const [s, minimum] of [[1, 0.85], [2.5, 0.5]] as const) {
    const sample = neuralRootProfileAtLength((end + s) * 20, 20, 1.5, 0.4, 1.8, 120);
    assert.ok(sample.width / 2 >= minimum * NEURAL_ROOT_MOUTH_RADII * 20,
      `process at ${s}R has half-width ${sample.width / 2}`);
  }
});

test("canvas sampling and both GPU uniforms use the one engine table", async () => {
  Object.assign(globalThis, { WebGL2RenderingContext: { BOOL: 1, BYTE: 2, UNSIGNED_BYTE: 3,
    SHORT: 4, UNSIGNED_SHORT: 5, INT: 6, UNSIGNED_INT: 7, FLOAT: 8 },
    WebGLRenderingContext: { TRIANGLES: 4, FLOAT: 8 } });
  const { FILAMENT_NEURAL_PROFILE_TABLE_2D } = await import("#render2d/filament-program.ts");
  assert.strictEqual(FILAMENT_NEURAL_PROFILE_TABLE_2D, NEURAL_PROFILE_TABLE);
  assert.strictEqual(FILAMENT_NEURAL_PROFILE_TABLE_3D, NEURAL_PROFILE_TABLE);
  assert.equal(NEURAL_PROFILE_TABLE.length, 64 * 4);
  for (const s of [0, 0.1, NEURAL_ROOT_FILLET_LENGTH_RADII, 0.5, 1.2, 2.5, 4, 6]) {
    const fromTable = neuralProfileTableAt(s);
    const fromCanvas = neuralRootProfileAtLength(s * 20, 20, 0, 0.4, 1.8, 120);
    assert.ok(Math.abs(fromCanvas.width / 2 / 20 - fromTable.halfWidthRadii * fromTable.somaMix) < 1e-6);
    assert.ok(Math.abs(fromCanvas.somaMix - fromTable.somaMix) < 1e-6);
  }
});
// D084-W2-NEURAL-R4 END

const wrap = (angle: number) => Math.atan2(Math.sin(angle), Math.cos(angle));

function silhouette(frame: NeuralSomaFrame, samples = 1440): readonly number[] {
  return Array.from({ length: samples }, (_, index) =>
    somaOutlineRadiusAtAngle(frame, 2 * Math.PI * index / samples));
}

test("the soma is a compact body whose strongest elongation points along a real relation", () => {
  for (const bearings of [bearingSets.pair, bearingSets.bundled, bearingSets.dense]) {
    const { nodes, edges, geometry } = hubFixture(bearings);
    const shape = geometry.nodes[0]!;
    // Base: the bundled and pair silhouettes carried a free spindle (1.6–2.2) or a
    // covariance eccentricity >= 1.24 — an elongation no drawn relation supports.
    assert.equal(shape.eccentricity, 1, `${bearings.length} edges: round body base`);
    assert.equal(shape.spindleRatio, undefined, `${bearings.length} edges: no spindle`);
    assert.ok((shape.trunks ?? []).every(trunk => trunk.edgeIds.every(id =>
      edges.some(edge => edge.id === id))), "elongations come only from real relations");
    const frame = frameOf(geometry, styleOf(nodes, edges));
    const radii = silhouette(frame);
    const aspect = Math.max(...radii) / Math.min(...radii);
    assert.ok(aspect <= 1.25, `${bearings.length} edges: compact aspect ${aspect}`);
    // The strongest elongation direction is a real incident direction (base: the pair's
    // spindle pole sat on the bundle bisector, over a radian from both relations).
    const peak = radii.indexOf(Math.max(...radii)) * 2 * Math.PI / radii.length;
    assert.ok(bearings.some(bearing => Math.abs(wrap(peak - bearing)) <= 0.35),
      `${bearings.length} edges: strongest elongation at ${peak} aligned with a real edge`);
  }
});

test("a zero-relation soma has no protrusion and no elongation", () => {
  const geometry = buildMorphologyGeometry("neural",
    [{ id: "alone", position: position(0, 0), radius: 8 }], []);
  const shape = geometry.nodes[0]!;
  assert.equal(shape.degree, 0);
  assert.deepEqual(shape.trunks, []);
  assert.equal(shape.eccentricity, 1);
  assert.equal(shape.spindleRatio, undefined);
  const frame = frameOf(geometry, styleOf([{ id: "alone" }], []), "alone");
  assert.deepEqual(frame.lobes, []);
  const radii = silhouette(frame);
  const aspect = Math.max(...radii) / Math.min(...radii);
  assert.ok(aspect <= 1.3, `an unconnected body stays a disc (aspect ${aspect})`);
  assert.ok(Math.max(...radii) <= 1.15 * frame.radius && Math.min(...radii) >= 0.85 * frame.radius,
    "only the bounded organic irregularity remains");
});

test("the root begins at the shoulder chord and remains thick for 2.5 radii", () => {
  // D084-W2-NEURAL-R3 BEGIN: this samples from the actual junction, including the
  // first step. The old full-radius mouth and compact 3D taper fail these bounds.
  for (const [radius, width] of [[6, 0.3], [8, 1.2], [12, 3]] as const) {
    const length = neuralRootLengthPx(radius, 140);
    const mouth = neuralRootProfileAtLength(0, radius, width, 0.4, 1.8, length);
    assert.ok(Math.abs(mouth.width - 2 * radius * Math.sqrt(1 - NEURAL_ROOT_ANCHOR_RADII ** 2)) < 1e-6);
    assert.ok(mouth.width / (2 * radius) >= 0.55 && mouth.width / (2 * radius) <= 0.65,
      `r=${radius}: junction half-width stays near the shoulder`);
    assert.ok(length >= Math.min(radius * NEURAL_ROOT_LENGTH_RADII, 140 * 0.45) - 1e-9);
    assert.ok(Math.abs(mouth.alpha - 0.9) < 1e-12, "the junction alpha matches the soma fill");
    let previousWidth = mouth.width, previousAlpha = mouth.alpha;
    for (let index = 1; index <= 200; index++) {
      const sample = neuralRootProfileAtLength((length + radius * NEURAL_ROOT_FILLET_LENGTH_RADII) * index / 200, radius, width, 0.4, 1.8, length);
      assert.ok(sample.width <= previousWidth + 1e-9, `r=${radius}: width rises at ${index}`);
      assert.ok(sample.alpha <= previousAlpha + 1e-9, `r=${radius}: alpha rises at ${index}`);
      assert.ok(previousWidth - sample.width <= 2.8 * (length + radius * NEURAL_ROOT_FILLET_LENGTH_RADII) / 200,
        `r=${radius}: no abrupt first width jump at ${index}`);
      previousWidth = sample.width; previousAlpha = sample.alpha;
    }
    const early = neuralRootProfileAtLength(2.5 * radius, radius, width, 0.4, 1.8, length);
    assert.ok(early.width >= 0.5 * (2 * radius * NEURAL_ROOT_MOUTH_RADII), "the process retains half its junction width for 2.5R");
    assert.equal(previousWidth, width, "the profile settles at the trunk width");
    assert.ok(Math.abs(previousAlpha - 0.4) < 1e-9, "the tail alpha matches the shaft");
  }
  // D084-W2-NEURAL-R3 END
});

test("degree 1, 3 and 12 junctions have a continuous union outline", () => {
  // D084-W2-NEURAL-R3 BEGIN: start at the shoulder chord, where the body actually
  // meets the root. Sampling from inside the body with an infinite initial bound
  // previously admitted the reference-visible full-width step.
  for (const bearings of [[0], [0, 2 * Math.PI / 3, 4 * Math.PI / 3], bearingSets.dense]) {
    const { nodes, edges, geometry } = hubFixture(bearings, 12, 200);
    for (const projection of ["2d", "3d"] as const) {
      const frame = neuralSomaFrames(geometry, point => ({ x: point.x, y: point.y, scale: 1 }),
        styleOf(nodes, edges), MORPHOLOGY_CONTRACT.neural, DEFAULT_APPEARANCE, projection).get("soma")!;
      const radius = frame.radius * (frame.leaf ? NEURAL_LEAF_BODY_SCALE : 1);
      const outline = Array.from({ length: 8193 }, (_, index) => {
        const angle = 2 * Math.PI * index / 8192;
        const r = somaOutlineRadiusAtAngle(frame, angle);
        return { x: r * Math.cos(angle), y: r * Math.sin(angle) };
      });
      const bodyHalfWidth = (x: number): number => {
        let half = 0;
        for (let i = 1; i < outline.length; i++) {
          const a = outline[i - 1]!, b = outline[i]!;
          if ((a.x - x) * (b.x - x) > 0 || Math.abs(a.x - b.x) < 1e-9) continue;
          half = Math.max(half, Math.abs(a.y + (b.y - a.y) * (x - a.x) / (b.x - a.x)));
        }
        return half;
      };
      const anchor = NEURAL_ROOT_ANCHOR_RADII * radius;
      const length = neuralRootLengthPx(radius, 200);
      const root = (s: number) => neuralRootProfileAtLength(s, radius, 1.5, 0.4, 1.8, length);
      const union = (x: number) => Math.max(bodyHalfWidth(x), root(Math.max(0, x - anchor)).width / 2);
      assert.ok(bodyHalfWidth(anchor) >= NEURAL_ROOT_MOUTH_RADII * radius - 0.15 * radius,
        `${projection} degree ${bearings.length}: body covers the root anchor`);
      const first = union(anchor);
      assert.ok(Math.abs(union(anchor + 0.001 * radius) - first) <= 0.03 * radius,
        `${projection} degree ${bearings.length}: no jump at the outline`);
      let previous = first;
      for (let i = 1; i <= 240; i++) {
        const x = anchor + length * i / 240;
        const half = union(x);
        assert.ok(half <= previous + 0.03 * radius,
          `${projection} degree ${bearings.length}: no neck then bulge at ${i}`);
        previous = half;
      }
      assert.ok(root(NEURAL_ROOT_FILLET_LENGTH_RADII * radius + 2.5 * radius).width >= NEURAL_ROOT_MOUTH_RADII * radius);
      assert.ok(root(length + NEURAL_ROOT_FILLET_LENGTH_RADII * radius).width === 1.5);
    }
  }
  // D084-W2-NEURAL-R3 END
});

test("no decorative filament fakes a relation the graph does not draw", () => {
  const canvasSource = readFileSync(new URL("../src/render-common/morphology-canvas.ts", import.meta.url), "utf8");
  const engineSource = readFileSync(new URL("../src/engine/morphology-geometry.ts", import.meta.url), "utf8");
  assert.ok(!canvasSource.includes("drawNeuralDetail"), "the canvas close-up offshoot is removed");
  assert.ok(!engineSource.includes("neuralDetailVisible"), "the engine sprout flag is removed");
  assert.doesNotMatch(FILAMENT_FRAGMENT_SHADER, /neuralBranchCoverage/,
    "the GPU cosmetic branch arm is removed");
});

test("the GPU body and root anchors carry the same organic profile as the canvas", () => {
  const { nodes, edges, geometry } = hubFixture([...bearingSets.bundled, ...bearingSets.dense], 8, 100);
  const graph = sceneFixtureGraph();
  const scene = buildScene(graph, { ...sceneVisualState(graph), morphology: "neural" });
  const template = scene.nodes[0]!;
  const shapes = new Map(geometry.nodes.map(node => [node.id, node]));
  const buffers = buildNodeBuffers(nodes.map(node => ({ ...template, id: node.id,
    position: node.position, radiusPx: node.radius })), scene.tokenEncoding,
    new Set(nodes.map(node => node.id)), shapes);
  for (const node of geometry.nodes) {
    const index = buffers.ids.indexOf(node.id);
    // Base: the bundled soma packed a covariance/spindle eccentricity far above 1.
    assert.equal(buffers.somaAxisAndEccentricity[index * 4 + 3]!, 1,
      `${node.id}: the GPU body is round`);
    for (const lobe of [buffers.somaLobe0, buffers.somaLobe1, buffers.somaLobe2]) {
      const strength = lobe[index * 4 + 3]!;
      if (strength === 0) continue;
      assert.ok(strength >= 0.04 - 1e-6 && strength <= 0.09 + 1e-6,
        `${node.id}: moderate broad lobe ${strength} (base packed 0.70–0.80 teardrops)`);
    }
    if (node.degree === 1)
      assert.ok(buffers.somaShape[index * 2 + 1]! <= NEURAL_LEAF_BODY_SCALE + 1e-6,
        "the degree-one body area carries NEURAL_LEAF_BODY_SCALE");
  }
  // Every GPU root radius is either the node radius or the leaf-anchored scale of it.
  const sceneBuffers = buildSceneBuffers(scene);
  const sceneRadius = new Map(scene.nodes.map(node => [node.id, node.radiusPx]));
  const stride = sceneBuffers.filaments.neuralProfile.length
    / Math.max(1, sceneBuffers.filaments.edgeIds.length);
  for (let index = 0; index < sceneBuffers.filaments.edgeIds.length; index++) {
    const source = sceneBuffers.filaments.sourceIds[index]!;
    const radius = sceneRadius.get(source) ?? 0;
    const anchored = sceneBuffers.filaments.neuralProfile[index * stride + 1]!;
    if (radius <= 0) continue;
    assert.ok(Math.abs(anchored - radius) < 1e-4
      || Math.abs(anchored - radius * NEURAL_LEAF_BODY_SCALE) < 1e-4,
      `GPU roots anchor at the body their cell actually draws (${anchored} vs ${radius})`);
  }
  // The GPU mouth spans the local soma extension with the same bounded response.
  assert.match(FILAMENT_FRAGMENT_SHADER, /neuralProfileSample/);
  assert.ok(FILAMENT_VERTEX_SHADER.includes(String(2 * NEURAL_PROFILE_TABLE[1]!)));
});

// D084-W2-NEURAL-R2 BEGIN: the small-drawn-radius regime — the 3D perspective and overview
// sizes the second rejection named (drops with a trailing tail, both projections).
test("small somata retain the full proportional root", () => {
  // D084-W2-NEURAL-R3 BEGIN: the earlier shortening caused the 3D ball and hairline.
  for (const radius of [4.2, 10.9, 24, 52.6]) {
    assert.equal(neuralRootCompactnessScale(radius, 3), 1);
    const length = neuralVisibleRootLengthPx(radius, 200, 1, false, 1)
      * neuralRootCompactnessScale(radius, 3);
    assert.equal(length, Math.min(200, Math.max(18, Math.min(6 * radius, 90))));
    const mouth = neuralRootProfileAtLength(0, radius, 1.5, 0.4, 1.8, length);
    if (length >= 2.5 * radius) {
      const early = neuralRootProfileAtLength((2.5 + NEURAL_ROOT_FILLET_LENGTH_RADII) * radius, radius, 1.5, 0.4, 1.8, length);
      assert.ok(early.width >= NEURAL_ROOT_MOUTH_RADII * radius, `radius ${radius}, length ${length}, early ${early.width}, process junction ${NEURAL_ROOT_MOUTH_RADII * radius}`);
    }
  }
  // D084-W2-NEURAL-R3 END
});

test("the leaf shaft keeps the approved root-to-body ratio at every drawn size", () => {
  // Base: min(0.9·R, 6·ordinary) pinned the near-soma shaft of a small leaf at 0.9 radii —
  // a tail half as thick as its body (the spermatozoon read). The 0.4-radii cap keeps the
  // approved close-up value bit-identical (6·ordinary still binds there) and gives a small
  // leaf the same shoulder ratio the approved state has.
  assert.equal(neuralLeafRootWidthPx(0, 3, 52.6), 18,
    "the approved close-up shaft is unchanged (6·ordinary binds)");
  assert.equal(neuralLeafRootWidthPx(0, 3, 10.9), 6,
    "the perspective-size leaf shaft eases from the 2·ordinary floor, not 0.9 radii");
  assert.equal(neuralLeafRootWidthPx(0, 3, 4.2), 6,
    "the overview leaf shaft stays at the same 2·ordinary floor");
});

test("dense WebGL, native 3D and canvas use the engine junction policy", () => {
  // D084-W2-NEURAL-R3 BEGIN: interpolation constants are inserted from the engine
  // into both shaders; dense leaf scale is a supplied endpoint attribute.
  const programSource = readFileSync(new URL("../src/render2d/filament-program.ts", import.meta.url), "utf8");
  const modelSource = readFileSync(new URL("../src/render2d/model.ts", import.meta.url), "utf8");
  assert.ok(FILAMENT_FRAGMENT_SHADER.includes(NEURAL_PROFILE_GLSL));
  assert.ok(programSource.includes("NEURAL_PROFILE_GLSL") && programSource.includes("NEURAL_PROFILE_TABLE"));
  assert.ok(FILAMENT_VERTEX_SHADER.includes(String(2 * NEURAL_PROFILE_TABLE[1]!)));
  assert.ok(programSource.includes('a_somaRadii", size: 4') && programSource.includes("a_somaRadii.zw")
    && modelSource.includes("neuralBodyScales"),
    "the dense path receives two endpoint scales packed with the soma radii");
  assert.ok(programSource.includes("NEURAL_ROOT_ANCHOR_RADII"));
  // The 3D buffer and canvas both already anchor leaves at this engine scale.
  assert.equal(NEURAL_LEAF_BODY_SCALE, 0.84);
  assert.equal(neuralEndpointBodyScale(1), NEURAL_LEAF_BODY_SCALE);
  assert.equal(neuralEndpointBodyScale(3), 1);
  assert.ok(modelSource.includes("neuralEndpointBodyScale"));
  const canvasSource = readFileSync(new URL("../src/render-common/morphology-canvas.ts", import.meta.url), "utf8");
  const nativeSource = readFileSync(new URL("../src/render3f/buffers.ts", import.meta.url), "utf8");
  assert.ok(canvasSource.includes("neuralEndpointBodyScale(startDegree)")
    && nativeSource.includes("neuralEndpointBodyScale(sourceNode?.degree"));
  // D084-W2-NEURAL-R3 END
});
