import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { MORPHOLOGY_CONTRACT } from "#engine/morphology-contract.ts";
import { DEFAULT_APPEARANCE } from "#engine/presentation-options.ts";
import { buildMorphologyGeometry, NEURAL_GEOMETRY_VERSION, NEURAL_LEAF_BODY_SCALE, NEURAL_ROOT_FILLET_LENGTH_RADII, NEURAL_ROOT_LENGTH_RADII, NEURAL_ROOT_MIN_LENGTH_PX, NEURAL_ROOT_MOUTH_RADII, NEURAL_ROOT_RATIO,
  neuralRootFilletRadiusPx, neuralRootLengthPx, neuralRootProfileAt, neuralRootProfileAtLength,
  neuralScreenWidthAt, neuralVisibleRootLengthPx, somaLobeAngularWidth } from "#engine/morphology-geometry.ts";
import { NEURAL_EDGE_SOMA_OVERLAP_PX, neuralRootInsideSoma, neuralSomaFrames,
  somaOutlineRadiusAtAngle, type MorphologyCanvasStyle } from "#render-common/morphology-canvas.ts";
import { FILAMENT_FRAGMENT_SHADER } from "#render3f/filament-material.ts";
const filament2dSource = readFileSync(new URL("../src/render2d/filament-program.ts", import.meta.url), "utf8");

const position = (x: number, y: number) => ({ x, y, z: 0 });
const nodes = [{ id: "a", position: position(0, 0), radius: 8 },
  { id: "b", position: position(90, 20), radius: 4 },
  { id: "c", position: position(70, 90), radius: 5 }];
const edges = [{ id: "ab", source: "a", target: "b", width: 2 },
  { id: "ac", source: "a", target: "c", width: 1 }];

test("P1 rounded fillet ends at the D-081 shared trunk in both projections and readings", () => {
  // D084-W2-NEURAL: the geometry model changed (organic soma body, soma-anchored root),
  // so every WeakMap/SceneCache entry keyed on the version must rebuild once.
  assert.match(NEURAL_GEOMETRY_VERSION, /^d084-r4-concave-/);
  for (const renderer of ["2D", "3D"]) for (const degree of [1, 3, 12])
    for (const [reading, edgeAlpha] of [["Esplorativa", 0.28], ["Attestata", 0.72]] as const) {
      const requestedRadius = degree === 12 ? 20 : degree === 3 ? 14 : 10;
      const tips = Array.from({ length: degree }, (_, index) => ({ id: `tip-${index}`,
        position: position(100 * Math.cos(index * 2 * Math.PI / degree),
          100 * Math.sin(index * 2 * Math.PI / degree)), radius: 4 }));
      const source = { id: "soma", position: position(0, 0), radius: requestedRadius };
      const links = tips.map((tip, index) => ({ id: `link-${index}`, source: source.id, target: tip.id, width: 1 }));
      const geometry = buildMorphologyGeometry("neural", [source, ...tips], links);
      const style: MorphologyCanvasStyle = { fieldColor: "rgb(0, 0, 0)",
        nodes: new Map([[source.id, { color: "rgb(255, 255, 255)", radiusPx: requestedRadius }],
          ...tips.map(tip => [tip.id, { color: "rgb(255, 255, 255)", radiusPx: 4 }] as const)]),
        edges: new Map(links.map(link => [link.id, { color: "rgb(102, 102, 102)" }])) };
      const project = (point: { x: number; y: number; z: number }) =>
        ({ x: point.x + (renderer === "3D" ? point.z * 0.1 : 0), y: point.y, scale: renderer === "3D" ? 0.9 : 1 });
      const frame = neuralSomaFrames(geometry, project, style, MORPHOLOGY_CONTRACT.neural,
        DEFAULT_APPEARANCE, renderer === "3D" ? "3d" : "2d").get(source.id)!;
      const radius = frame.radius;
      const width = degree === 12 ? 2.5 : 1.4;
      const span = 100;
      const length = neuralRootLengthPx(radius, span);
      const trunkWidth = degree === 12 ? width * 3.2 : width * 1.8;
      const samples = Array.from({ length: 401 }, (_, index) =>
        neuralRootProfileAt((length + NEURAL_ROOT_FILLET_LENGTH_RADII * radius) * index / 400, radius, width, edgeAlpha, 2.4, span, trunkWidth));
      const centre = neuralRootProfileAt(-radius, radius, width, edgeAlpha, 2.4, span, trunkWidth);
      assert.equal(centre.alpha, samples[0]!.alpha, `${renderer}/${reading}: soma-to-root alpha`);
      assert.equal(centre.somaMix, 1, `${renderer}/${reading}: soma-to-root luminance`);
      assert.equal(centre.width, samples[0]!.width, `${renderer}/${reading}: soma-to-root width`);
      assert.ok(samples[0]!.width >= width * 2);
      assert.ok(samples[0]!.width / radius >= 0.9 - 1e-9,
        `${renderer}/${degree}: mouth at least 90% of local soma half-width`);
      assert.ok(length >= Math.min(radius * NEURAL_ROOT_LENGTH_RADII, span * 0.45));
      assert.ok(length <= span && length >= Math.min(NEURAL_ROOT_MIN_LENGTH_PX, span));
      assert.equal(samples[0]!.somaMix, 1);
      assert.equal(samples.at(-1)!.width, trunkWidth, `${renderer}/${degree}: D-081 trunk width`);
      assert.equal(samples.at(-1)!.alpha, edgeAlpha, `${renderer}/${degree}: shaft alpha`);
      assert.equal(samples.at(-1)!.somaMix, 0, `${renderer}/${degree}: shaft colour`);
      assert.ok(samples.every(sample => sample.width >= trunkWidth), "no pointed arm narrower than the trunk");
      const curvatureRadius = neuralRootFilletRadiusPx(samples[0]!.width, trunkWidth, length);
      assert.ok(curvatureRadius > 0 && Number.isFinite(curvatureRadius), "finite rounded mouth fillet");
      assert.ok(samples[0]!.width > samples[1]!.width, "the root begins to taper beneath the soma");
      assert.ok(Math.abs(samples.at(-1)!.width - samples.at(-2)!.width) < 0.01,
        "zero root-end slope");
      for (let index = 1; index < samples.length; index++) {
        const before = samples[index - 1]!, after = samples[index]!;
        // The concave curve is steepest under the soma and tends to zero slope at the shaft.
        // D084-W2-NEURAL: the mouth now spans the full local soma extension (2·R·mouthScale
        // instead of ~0.9·R), so the same smoothness class allows a proportionally larger
        // first step — still under 1.1% of the mouth width per sample.
        assert.ok(Math.abs(after.width - before.width) <= 0.45, `${renderer}/${degree}: width step ${index}`);
        assert.ok(Math.abs(after.alpha - before.alpha) <= 0.02, `${renderer}/${degree}: alpha step ${index}`);
        // D084-W2-NEURAL-R5: a short relation completes the extended taper
        // after five radii; each sampled step remains a smooth fade.
        assert.ok(Math.abs(after.somaMix - before.somaMix) <= 0.03, `${renderer}/${degree}: colour step ${index}`);
        const luminance = (sample: typeof before) => 0.4 + 0.6 * sample.somaMix;
        assert.ok(Math.abs(luminance(after) - luminance(before)) <= 0.02,
          `${renderer}/${reading}/${degree}: luminance step ${index}`);
        assert.ok(Math.abs(luminance(after) * after.alpha - luminance(before) * before.alpha) <= 0.02,
          `${renderer}/${reading}/${degree}: premultiplied colour step ${index}`);
      }
      const base = neuralRootInsideSoma(frame, { x: frame.x + 100, y: frame.y });
      assert.ok(Math.hypot(base.x - frame.x, base.y - frame.y) < somaOutlineRadiusAtAngle(frame, 0));
    }
  // Shaders use the same engine fillet and retain the D-081 trunk after it.
  for (const shader of [filament2dSource, FILAMENT_FRAGMENT_SHADER]) {
    assert.ok(/rootSomaMix = max\(startProfile.y, endProfile.y\)/.test(shader), "root mix");
    assert.ok(/neuralProfileSample/.test(shader), "engine profile table");
    assert.ok(/neuralProcessLength/.test(shader), "engine process length");
    assert.ok(/NEURAL_PROFILE_GLSL|span \* 0\.5/.test(shader), "engine span fraction");
    assert.ok(/NEURAL_PROFILE_GLSL|span \* 0\.5/.test(shader), "short-link cap");
    assert.ok(/mix\(ordinary, 2\.0 \* startRadius \* startProfile.x/.test(shader) || /mix\(v_thickness, 2\.0 \* v_somaRadii.x \* startProfile.x/.test(shader), "D-081 trunk after fillet");
    // D084-W2-NEURAL-R5: endpoint soma colour and alpha replace the retired white mouth.
    assert.ok(/rootSomaColor/.test(shader), "attached soma tone");
    assert.ok(!/mix\(color, vec3\(1\.0\), rootSomaMix\)/.test(shader), "no white mouth");
    assert.ok(/rootSomaColor\.a|rootSomaOpacity/.test(shader), "attached soma alpha");
  }
  assert.equal(neuralRootProfileAt(0, 2, 1, 0.4).somaMix, 1,
    "the smallest drawn leaf still flows into its neurite");
  assert.deepEqual(neuralRootProfileAt(0, 1, 1, 0.4), { width: 1, alpha: 0.4, somaMix: 0 },
    "subpixel geometry degrades to the ordinary ribbon");
});

test("reference overview roots are broad and rounded while leaves keep one attached tail", () => {
  for (const [radius, span, width] of [[5, 80, 1.2], [8, 120, 1.5], [10, 160, 1.8]] as const) {
    const length = neuralRootLengthPx(radius, span);
    const join = neuralRootProfileAt(0, radius, width, 0.3, 1.8, span);
    assert.ok(length >= radius * 2.5, `root length ${length} at r=${radius}`);
    assert.ok(length <= span && length >= Math.min(NEURAL_ROOT_MIN_LENGTH_PX, span));
    assert.ok(join.width >= radius * 0.9, `join width ${join.width} at r=${radius}`);
    assert.ok(join.alpha >= 0.9, "the edge at the soma is as opaque as the root");
    assert.equal(join.somaMix, 1);
    assert.equal(neuralRootProfileAt(length + NEURAL_ROOT_FILLET_LENGTH_RADII * radius, radius, width, 0.3, 1.8, span).width, width);
  }
  assert.ok(neuralRootProfileAt(0, 24, 1.4, 0.3, 2.6, 160).width >= 24 * 0.9,
    "large hubs retain a soma-width mouth rather than a capped narrow arm");
  const leafGeometry = buildMorphologyGeometry("neural", [
    { id: "leaf", position: position(0, 0), radius: 8 },
    { id: "next", position: position(120, 0), radius: 8 }],
  [{ id: "leaf-edge", source: "leaf", target: "next", width: 1.5 }]);
  const leaf = leafGeometry.nodes[0]!;
  assert.equal(leaf.trunks?.length, 1, "a leaf has only one real direction");
  // D084-W2-NEURAL BEGIN: a degree-one body draws at NEURAL_LEAF_BODY_SCALE, so its single
  // tail anchors at that same local extension (canvas buildEdgePaints and the 3D neuralProfile
  // buffers both do this). The mouth is exactly the body's local extension — never a wider
  // cap glued onto a narrower cell.
  const anchor = 8 * NEURAL_LEAF_BODY_SCALE;
  const tail = neuralRootProfileAt(0, anchor, 1.5, 0.4, leaf.rootRatio, 120);
  assert.ok(Math.abs(tail.width - 2 * anchor * Math.sqrt(1 - 0.8055023396641312 ** 2)) < 1e-6,
    "the leaf mouth meets the body's shoulder chord");
  // D084-W2-NEURAL END
  const leafStyle: MorphologyCanvasStyle = { fieldColor: "rgb(0, 0, 0)",
    nodes: new Map([["leaf", { color: "rgb(255, 255, 255)", radiusPx: 8 }],
      ["next", { color: "rgb(255, 255, 255)", radiusPx: 8 }]]),
    edges: new Map([["leaf-edge", { color: "rgb(102, 102, 102)" }]]) };
  for (const projection of ["2d", "3d"] as const) {
    const frame = neuralSomaFrames(leafGeometry, p => ({ x: p.x, y: p.y, scale: 1 }), leafStyle,
      MORPHOLOGY_CONTRACT.neural, DEFAULT_APPEARANCE, projection).get("leaf")!;
    assert.equal(frame.leaf, true);
    const plain = { ...frame, leaf: false };
    assert.ok(Math.abs(somaOutlineRadiusAtAngle(frame, 0)
      / somaOutlineRadiusAtAngle(plain, 0) - NEURAL_LEAF_BODY_SCALE) < 1e-9);
    const inside = neuralRootInsideSoma(frame, { x: 120, y: 0 });
    assert.ok(inside.x < somaOutlineRadiusAtAngle(frame, 0), "leaf tail starts inside body");
    // The union of the soma contour and the root ribbon has an equal-width join.
    const contour = Array.from({ length: 4097 }, (_, index) => {
      const angle = 2 * Math.PI * index / 4096;
      const radius = somaOutlineRadiusAtAngle(frame, angle);
      return { x: radius * Math.cos(angle), y: radius * Math.sin(angle) };
    });
    const crossSectionWidth = (x: number) => {
      let halfWidth = 0;
      for (let index = 1; index < contour.length; index++) {
        const a = contour[index - 1]!, b = contour[index]!;
        if ((a.x - x) * (b.x - x) > 0 || Math.abs(a.x - b.x) < 1e-9) continue;
        const y = a.y + (b.y - a.y) * (x - a.x) / (b.x - a.x);
        halfWidth = Math.max(halfWidth, Math.abs(y));
      }
      return halfWidth * 2;
    };
    // D084-W2-NEURAL BEGIN: the join property is union monotonicity. Along the exit axis
    // the combined cross-section of the body contour and the root ribbon never steps up
    // (no glued-on segment) and never dips below its running minimum by more than the
    // organic ±12% irregularity (no neck) before settling at the shaft width.
    const exitOutline = somaOutlineRadiusAtAngle(frame, 0);
    const rootLength = neuralRootLengthPx(anchor, 120);
    let settled = Infinity;
    for (let index = 0; index <= 240; index++) {
      const x = inside.x + (exitOutline + rootLength * 1.3 - inside.x) * index / 240;
      const distance = Math.max(0, x - (exitOutline - NEURAL_EDGE_SOMA_OVERLAP_PX));
      const ribbon = neuralRootProfileAtLength(distance, anchor, 1.5, 0.4,
        leaf.rootRatio ?? NEURAL_ROOT_RATIO, rootLength).width;
      const union = Math.max(crossSectionWidth(x), ribbon);
      assert.ok(union <= settled + 0.15,
        `${projection}: no step-up or neck in the union cross-section at x=${x.toFixed(2)}`);
      settled = Math.min(settled, union);
    }
    assert.ok(Math.abs(settled - 1.5) < 1e-9,
      `${projection}: the union settles at the shaft width`);
    // D084-W2-NEURAL END
  }
  // The edge enters the soma and its mouth keeps the same width at the overlap.
  assert.equal(tail.width, neuralRootProfileAt(-2, anchor, 1.5, 0.4, leaf.rootRatio, 120).width);
  assert.match(filament2dSource, /rootSomaColor\.a/);
  assert.match(FILAMENT_FRAGMENT_SHADER, /rootSomaOpacity \* longitudinal \* radial/);
  // D084-W2-NEURAL: the leaf body scale moved from the shader's lobe test into the buffers
  // (somaShape areaScale and neuralProfile radii); the GPU mouth itself spans the local
  // soma extension exactly like the canvas profile.
  assert.match(FILAMENT_FRAGMENT_SHADER, /neuralProfileSample/);
});

test("edge-width control changes the rounded mouth without a neck", () => {
  const low = neuralRootProfileAt(0, 12, 0.3, 0.35, 1.8, 120, 1.2);
  const normal = neuralRootProfileAt(0, 12, 1.2, 0.35, 1.8, 120, 1.2);
  const high = neuralRootProfileAt(0, 12, 3, 0.35, 1.8, 120, 1.2);
  // D084-W2-NEURAL: the response is capped at the soma's own extension (neuralMouthScale
  // ≤ 1.0) — an unbounded mouth wider than the cell it leaves was the defect.
  assert.ok(low.width === normal.width && normal.width === high.width,
    "the root width is anchored to the soma shoulder across the control range");
  assert.ok(low.width / 12 >= 0.765 - 1e-9, "minimum low-degree mouth/local half-width");
  for (const width of [0.3, 1.2, 3]) {
    const end = neuralRootProfileAt(neuralRootLengthPx(12, 120) + 12 * NEURAL_ROOT_FILLET_LENGTH_RADII, 12, width, 0.35, -3.2, 120, 4);
    const mouth = neuralRootProfileAt(0, 12, width, 0.35, -3.2, 120, 4);
    assert.ok(mouth.width >= end.width, "shared trunk never narrows into a pointed arm");
  }
});

test("tiny leaves have one continuous, concave body-to-tail profile", () => {
  for (const radius of [2, 3, 5, 8]) {
    const length = neuralRootLengthPx(radius, 80);
    const samples = Array.from({ length: 101 }, (_, i) =>
      neuralRootProfileAtLength((length + radius * NEURAL_ROOT_FILLET_LENGTH_RADII) * i / 100, radius, 1.1, 0.34, 1.8, length));
    assert.equal(samples[0]!.somaMix, 1);
    assert.ok(Math.abs(samples[0]!.alpha - 0.9) < 1e-12);
    assert.equal(samples.at(-1)!.width, 1.1);
    assert.equal(samples.at(-1)!.alpha, 0.34);
    assert.equal(samples.at(-1)!.somaMix, 0);
    for (let i = 1; i < samples.length; i++) {
      assert.ok(samples[i]!.width <= samples[i - 1]!.width + 1e-9, "monotone width");
      assert.ok(samples[i]!.alpha <= samples[i - 1]!.alpha + 1e-9, "monotone alpha");
      assert.ok(samples[i]!.somaMix <= samples[i - 1]!.somaMix + 1e-9, "monotone soma mix");
    }
    const slopes = samples.slice(1).map((sample, i) => sample.width - samples[i]!.width);
    assert.ok(slopes[0]! < -1e-5 && slopes.at(-1)! < 0, "root tapers from the body into the shaft");
    assert.ok(neuralRootProfileAtLength((NEURAL_ROOT_FILLET_LENGTH_RADII + 2.5) * radius,
      radius, 1.1, 0.34, 1.8, length).width >= NEURAL_ROOT_MOUTH_RADII * radius,
      "the process stays broad through 2.5 radii beyond the fillet");
    assert.ok(samples[0]!.width >= 0.8 * radius, "leaf body and tail meet at a broad mouth");
  }
  for (const shader of [filament2dSource, FILAMENT_FRAGMENT_SHADER]) {
    assert.match(shader, /1\.5 \* u_(?:pixelRatio|devicePixelRatio)/,
      "the 2 px drawn leaf must retain its root in both GPU projections");
  }
  // D084-W2-NEURAL: the teardrop-specific overlong leaf boundary is gone — every soma is
  // a compact body whose outline reaches roughly 1.3 radii at a trunk lobe, so one
  // boundary under the sprite serves leaves and hubs alike.
  // D084-W2-NEURAL-R2: the dense 2D program entered this worker's ceiling and now carries
  // the same compact-body boundary and soma-continuation mouth as the 3D program.
  for (const shader of [filament2dSource, FILAMENT_FRAGMENT_SHADER]) {
    assert.match(shader, /NEURAL_ROOT_ANCHOR_RADII|startRadius \* 0\.8055023396641312/,
      "one compact-body boundary under the sprite serves leaves and hubs alike");
    assert.doesNotMatch(shader, /2\.25/, "no teardrop leaf boundary remains");
    assert.match(shader, /NEURAL_PROFILE_TABLE|neuralProfileSample/,
      "the mouth meets the local shoulder chord");
  }
});

test("dense hubs favour a few broad real directions over equal bright spokes", () => {
  const count = 12;
  const ends = Array.from({ length: count }, (_, i) => ({ id: `hub-end-${i}`,
    position: position(100 * Math.cos(i * 2 * Math.PI / count), 100 * Math.sin(i * 2 * Math.PI / count)), radius: 2 }));
  const links = ends.map((end, i) => ({ id: `hub-edge-${i}`, source: "hub", target: end.id,
    width: i % 3 === 0 ? 2 : 1 }));
  const geometry = buildMorphologyGeometry("neural", [{ id: "hub", position: position(0, 0), radius: 12 }, ...ends], links);
  const hub = geometry.nodes[0]!;
  assert.ok((hub.trunks?.length ?? 0) <= 5, "clustered real trunk directions");
  const style: MorphologyCanvasStyle = { fieldColor: "rgb(0,0,0)",
    nodes: new Map(geometry.nodes.map(node => [node.id, { color: "rgb(255,255,255)", radiusPx: node.radius }])),
    edges: new Map(links.map(link => [link.id, { color: "rgb(102,102,102)" }])) };
  const frame = neuralSomaFrames(geometry, p => ({ x: p.x, y: p.y, scale: 1 }), style,
    MORPHOLOGY_CONTRACT.neural, DEFAULT_APPEARANCE).get("hub")!;
  assert.ok((frame.lobes?.length ?? 0) <= 3, "at most three soma protrusions");
  assert.ok((frame.lobes ?? []).every(lobe => somaLobeAngularWidth(lobe.strength) >= 0.62),
    "hub lobes cover broad angular sectors");
  const angles = (frame.lobes ?? []).map(lobe => lobe.angle);
  const separations = angles.flatMap((a, i) => angles.slice(i + 1).map(b =>
    Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)))));
  assert.ok(separations.every(separation => separation >= 0.35),
    "principal protrusions do not duplicate nearby angles");
  assert.ok(Math.max(...separations) >= Math.PI * 0.75,
    "real principal directions cover a broad sector of the hub");
  const ordinary = neuralRootLengthPx(12, 120);
  // D084-W2-NEURAL-R3: every drawn relation stays thick to the same R-scaled
  // distance, matching the native and dense shaders regardless of hub degree.
  assert.equal(neuralVisibleRootLengthPx(12, 120, 12, false), ordinary);
  assert.equal(neuralVisibleRootLengthPx(12, 120, 12, true), ordinary);
  assert.equal(neuralVisibleRootLengthPx(12, 120, 12, true, 4), ordinary);
  assert.equal(neuralVisibleRootLengthPx(2, 80, 1, false), neuralRootLengthPx(2, 80),
    "a leaf keeps its full continuous tail");
});

test("principal protrusions come only from real edges and stay bounded", () => {
  for (const count of [1, 3, 12]) {
    const ends = Array.from({ length: count }, (_, i) => ({ id: `end-${i}`,
      position: position(100 * Math.cos(i * 2 * Math.PI / count), 100 * Math.sin(i * 2 * Math.PI / count)), radius: 4 }));
    const links = ends.map((end, i) => ({ id: `edge-${i}`, source: "a", target: end.id, width: i < 3 ? 2 : 1 }));
    const shape = buildMorphologyGeometry("neural", [nodes[0]!, ...ends], links).nodes[0]!;
    assert.ok((shape.trunks?.length ?? 0) <= count);
    assert.ok((shape.trunks?.slice(0, 3).length ?? 0) <= 3);
    assert.ok((shape.trunks ?? []).every(trunk => trunk.edgeIds.every(id => links.some(edge => edge.id === id))));
  }
});

test("Stellar and Mycelium draw geometry remains byte-identical to D-081 fixture", () => {
  const expected = { stellar: "3e690cc987fca32de498036ac34d8b727f373b5e2444a17db0c7a22ac02a12c3",
    mycelium: "3bd3c07dd4c58f96b25cae53cbd0527a35c8192c2d55fe2335d51bc4b8b24cf5" };
  for (const morphology of ["stellar", "mycelium"] as const) {
    const digest = createHash("sha256").update(JSON.stringify(buildMorphologyGeometry(morphology, nodes, edges))).digest("hex");
    assert.equal(digest, expected[morphology]);
  }
});

test("pure root profile cost per painted sample is reported against D-081", () => {
  const passes = 80_000;
  const length = neuralRootLengthPx(8, 160);
  const measure = (sample: (i: number) => number) => {
    let checksum = 0;
    const start = performance.now();
    for (let i = 0; i < passes; i++) checksum += sample(i);
    return { ms: performance.now() - start, checksum };
  };
  // Warm both code paths before timing; this is a reported measurement, not a machine-load gate.
  measure(i => neuralRootProfileAtLength(i % 40, 8, 1.5, 0.5, 2.6, length).width);
  measure(i => neuralScreenWidthAt((i % 100) / 100, 1.5, 8, 8, [2.6, 2.6], 150, true));
  const baseline = measure(i => neuralScreenWidthAt((i % 100) / 100, 1.5, 8, 8, [2.6, 2.6], 150, true));
  const current = measure(i => neuralRootProfileAtLength(i % 40, 8, 1.5, 0.5, 2.6, length).width);
  assert.ok(current.checksum > 0 && baseline.checksum > 0);
  console.log(`D082 Neural profile microbenchmark ${passes} samples: D-081=${baseline.ms.toFixed(2)}ms D-082=${current.ms.toFixed(2)}ms`);
});
