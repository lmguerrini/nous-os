import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { MORPHOLOGY_CONTRACT } from "#engine/morphology-contract.ts";
import { DEFAULT_APPEARANCE } from "#engine/presentation-options.ts";
import { buildMorphologyGeometry, NEURAL_GEOMETRY_VERSION, NEURAL_LEAF_BODY_SCALE, NEURAL_ROOT_LENGTH_RADII,
  neuralRootFilletRadiusPx, neuralRootLengthPx, neuralRootProfileAt, neuralRootProfileAtLength,
  neuralScreenWidthAt } from "#engine/morphology-geometry.ts";
import { neuralRootInsideSoma, neuralSomaFrames, somaOutlineRadiusAtAngle,
  type MorphologyCanvasStyle } from "#render-common/morphology-canvas.ts";
import { FILAMENT_FRAGMENT_SHADER } from "#render3f/filament-material.ts";
import { NODE_FRAGMENT_SHADER } from "#render3f/node-material.ts";
const filament2dSource = readFileSync(new URL("../src/render2d/filament-program.ts", import.meta.url), "utf8");

const position = (x: number, y: number) => ({ x, y, z: 0 });
const nodes = [{ id: "a", position: position(0, 0), radius: 8 },
  { id: "b", position: position(90, 20), radius: 4 },
  { id: "c", position: position(70, 90), radius: 5 }];
const edges = [{ id: "ab", source: "a", target: "b", width: 2 },
  { id: "ac", source: "a", target: "c", width: 1 }];

test("P1 rounded fillet ends at the D-081 shared trunk in both projections and readings", () => {
  assert.match(NEURAL_GEOMETRY_VERSION, /^d082-p1-/);
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
      const samples = Array.from({ length: 201 }, (_, index) =>
        neuralRootProfileAt(length * index / 200, radius, width, edgeAlpha, 2.4, span, trunkWidth));
      const centre = neuralRootProfileAt(-radius, radius, width, edgeAlpha, 2.4, span, trunkWidth);
      assert.equal(centre.alpha, samples[0]!.alpha, `${renderer}/${reading}: soma-to-root alpha`);
      assert.equal(centre.somaMix, 1, `${renderer}/${reading}: soma-to-root luminance`);
      assert.equal(centre.width, samples[0]!.width, `${renderer}/${reading}: soma-to-root width`);
      assert.ok(samples[0]!.width >= width * 2);
      assert.ok(samples[0]!.width / radius >= 0.9 - 1e-9,
        `${renderer}/${degree}: mouth at least 90% of local soma half-width`);
      assert.ok(length >= Math.min(radius * NEURAL_ROOT_LENGTH_RADII, span * 0.45));
      assert.ok(length <= Math.min(radius * 3, span * 0.45));
      assert.equal(samples[0]!.somaMix, 1);
      assert.equal(samples.at(-1)!.width, trunkWidth, `${renderer}/${degree}: D-081 trunk width`);
      assert.equal(samples.at(-1)!.alpha, edgeAlpha, `${renderer}/${degree}: shaft alpha`);
      assert.equal(samples.at(-1)!.somaMix, 0, `${renderer}/${degree}: shaft colour`);
      assert.ok(samples.every(sample => sample.width >= trunkWidth), "no pointed arm narrower than the trunk");
      const curvatureRadius = neuralRootFilletRadiusPx(samples[0]!.width, trunkWidth, length);
      assert.ok(curvatureRadius > 0 && Number.isFinite(curvatureRadius), "finite rounded mouth fillet");
      assert.ok(Math.abs(samples[1]!.width - samples[0]!.width) < 0.01, "zero mouth slope");
      assert.ok(Math.abs(samples.at(-1)!.width - samples.at(-2)!.width) < 0.01,
        "zero root-end slope");
      for (let index = 1; index < samples.length; index++) {
        const before = samples[index - 1]!, after = samples[index]!;
        // 0.16 px, 0.01 alpha and 0.01 white mix per 1/200 shoulder step.
        assert.ok(Math.abs(after.width - before.width) <= 0.16, `${renderer}/${degree}: width step ${index}`);
        assert.ok(Math.abs(after.alpha - before.alpha) <= 0.01, `${renderer}/${degree}: alpha step ${index}`);
        assert.ok(Math.abs(after.somaMix - before.somaMix) <= 0.01, `${renderer}/${degree}: colour step ${index}`);
        const luminance = (sample: typeof before) => 0.4 + 0.6 * sample.somaMix;
        assert.ok(Math.abs(luminance(after) - luminance(before)) <= 0.01,
          `${renderer}/${reading}/${degree}: luminance step ${index}`);
        assert.ok(Math.abs(luminance(after) * after.alpha - luminance(before) * before.alpha) <= 0.02,
          `${renderer}/${reading}/${degree}: premultiplied colour step ${index}`);
      }
      const base = neuralRootInsideSoma(frame, { x: frame.x + 100, y: frame.y });
      assert.ok(Math.hypot(base.x - frame.x, base.y - frame.y) < somaOutlineRadiusAtAngle(frame, 0));
    }
  // Shaders use the same 2.5–3-radius fillet and retain the D-081 trunk after it.
  for (const shader of [filament2dSource, FILAMENT_FRAGMENT_SHADER]) {
    assert.ok(/rootSomaMix = max\(startEase, endEase\)/.test(shader), "root mix");
    assert.ok(/startRadius \* 2\.5|v_somaRadii\.x \* 2\.5/.test(shader), "short rounded fillet");
    assert.ok(/span \* 0\.12/.test(shader), "span fraction");
    assert.ok(/span \* 0\.45/.test(shader), "short-link cap");
    assert.ok(/oldStartShoulder/.test(shader) && /startTrunk/.test(shader), "D-081 trunk after fillet");
    assert.ok(/mix\([^;]*vec3\(1\.0\), rootSomaMix\)/.test(shader), "white-to-edge colour");
    assert.ok(/mix\([^;]*max\(0\.9, [^;]*rootSomaMix\)/.test(shader), "soma-to-edge alpha");
  }
  assert.deepEqual(neuralRootProfileAt(0, 2, 1, 0.4), { width: 1, alpha: 0.4, somaMix: 0 },
    "a final soma radius below 3 px degrades without a seam");
});

test("reference overview roots are broad and rounded while leaves keep one attached tail", () => {
  for (const [radius, span, width] of [[5, 80, 1.2], [8, 120, 1.5], [10, 160, 1.8]] as const) {
    const length = neuralRootLengthPx(radius, span);
    const join = neuralRootProfileAt(0, radius, width, 0.3, 1.8, span);
    assert.ok(length >= radius * 2.5, `root length ${length} at r=${radius}`);
    assert.ok(length <= Math.min(radius * 3, span * 0.45));
    assert.ok(join.width >= radius * 0.9, `join width ${join.width} at r=${radius}`);
    assert.ok(join.alpha >= 0.9, "the edge at the soma is as opaque as the root");
    assert.equal(join.somaMix, 1);
    assert.equal(neuralRootProfileAt(length, radius, width, 0.3, 1.8, span).width, width);
  }
  assert.ok(neuralRootProfileAt(0, 24, 1.4, 0.3, 2.6, 160).width >= 24 * 0.9,
    "large hubs retain a soma-width mouth rather than a capped narrow arm");
  const leafGeometry = buildMorphologyGeometry("neural", [
    { id: "leaf", position: position(0, 0), radius: 8 },
    { id: "next", position: position(120, 0), radius: 8 }],
  [{ id: "leaf-edge", source: "leaf", target: "next", width: 1.5 }]);
  const leaf = leafGeometry.nodes[0]!;
  assert.equal(leaf.trunks?.length, 1, "a leaf has only one real direction");
  const tail = neuralRootProfileAt(0, 8, 1.5, 0.4, leaf.rootRatio, 120);
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
    let low = 0, high = somaOutlineRadiusAtAngle(frame, 0);
    assert.ok(crossSectionWidth(low) > tail.width, "body must surround the mouth");
    for (let index = 0; index < 32; index++) {
      const middle = (low + high) / 2;
      if (crossSectionWidth(middle) > tail.width) low = middle; else high = middle;
    }
    assert.ok(inside.x < high, "the ribbon enters before the visible join");
    assert.ok(Math.abs(crossSectionWidth(high) - tail.width) < 0.02,
      `${projection}: leaf body and tail are the same width at their visible join`);
  }
  // The edge enters the soma and its mouth keeps the same width at the overlap.
  assert.equal(tail.width, neuralRootProfileAt(-2, 8, 1.5, 0.4, leaf.rootRatio, 120).width);
  assert.match(filament2dSource, /max\(0\.9, v_color\.a \* propagationAlpha\) \* bodyCoverage/);
  assert.match(FILAMENT_FRAGMENT_SHADER, /max\(0\.9, v_opacity \* longitudinal\) \* radial/);
  assert.match(NODE_FRAGMENT_SHADER, /\? 0\.84 : 1\.0/);
});

test("edge-width control changes the rounded mouth without a neck", () => {
  const low = neuralRootProfileAt(0, 12, 0.3, 0.35, 1.8, 120, 1.2);
  const normal = neuralRootProfileAt(0, 12, 1.2, 0.35, 1.8, 120, 1.2);
  const high = neuralRootProfileAt(0, 12, 3, 0.35, 1.8, 120, 1.2);
  assert.ok(low.width < normal.width && normal.width < high.width);
  assert.ok(low.width / 12 >= 0.765 - 1e-9, "minimum low-degree mouth/local half-width");
  for (const width of [0.3, 1.2, 3]) {
    const end = neuralRootProfileAt(neuralRootLengthPx(12, 120), 12, width, 0.35, -3.2, 120, 4);
    const mouth = neuralRootProfileAt(0, 12, width, 0.35, -3.2, 120, 4);
    assert.ok(mouth.width >= end.width, "shared trunk never narrows into a pointed arm");
  }
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
