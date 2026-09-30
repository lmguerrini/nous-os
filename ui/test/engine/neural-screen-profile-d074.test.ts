import assert from "node:assert/strict";
import { test } from "node:test";
import { buildMorphologyGeometry, NEURAL_ROOT_CAP_PX, NEURAL_TAPER_FRACTION, neuralScreenWidthAt } from "#engine/morphology-geometry.ts";
import { DEFAULT_APPEARANCE } from "#engine/presentation-options.ts";
import { drawMorphologyCanvas, smoothNeuralCurve, type MorphologyCanvasStyle } from "#render-common/morphology-canvas.ts";

test("Neural screen profile has two bounded, monotone, C1 shoulders and a slider-width shaft", () => {
  for (const slider of [0.3, 1, 3]) {
    const width = (t: number) => neuralScreenWidthAt(t, slider, 7, 7);
    assert.equal(width(0.5), slider);
    assert.equal(width(0), width(1));
    assert.ok(width(0) > slider && width(0) <= Math.min(NEURAL_ROOT_CAP_PX, 7 * 1.8));
    for (let i = 1; i <= 100; i++) assert.ok(width(i * NEURAL_TAPER_FRACTION / 100) <= width((i - 1) * NEURAL_TAPER_FRACTION / 100) + 1e-12);
    const h = 1e-5;
    for (const join of [NEURAL_TAPER_FRACTION, 0.5, 1 - NEURAL_TAPER_FRACTION]) {
      const left = (width(join) - width(join - h)) / h;
      const right = (width(join + h) - width(join)) / h;
      assert.ok(Math.abs(left - right) < 0.003, `${join}: ${left} vs ${right}`);
    }
    assert.equal(neuralScreenWidthAt(0.5, slider, 7, 7), slider, "the shaft has no zoom input");
    assert.equal(neuralScreenWidthAt(1, slider, 7, 0), slider, "a non-soma end stays ordinary");
  }
});

test("projected Neural centre-line has small turns after dense-scene sample reduction", () => {
  const geometry = buildMorphologyGeometry("neural", [
    { id: "a", position: { x: 0, y: 0, z: 0 }, radius: 7 },
    { id: "b", position: { x: 320, y: 0, z: 0 }, radius: 7 },
  ], [{ id: "ab", source: "a", target: "b", width: 1 }]);
  const samples = geometry.drawnSegments[0]!.samples.filter((_, i) => i % 4 === 0);
  for (const zoom of [1, 3, 6]) {
    const curve = smoothNeuralCurve(samples.map(point => ({ x: point.x * zoom, y: point.y * zoom, scale: zoom })));
    assert.deepEqual(curve[0], { x: samples[0]!.x * zoom, y: samples[0]!.y * zoom, scale: zoom });
    assert.deepEqual(curve.at(-1), { x: samples.at(-1)!.x * zoom, y: samples.at(-1)!.y * zoom, scale: zoom });
    for (let i = 2; i < curve.length; i++) {
      const a = curve[i - 2]!, b = curve[i - 1]!, c = curve[i]!;
      const turn = Math.abs(Math.atan2((b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x),
        (b.x - a.x) * (c.x - b.x) + (b.y - a.y) * (c.y - b.y)));
      assert.ok(turn < 0.12, `zoom ${zoom}, segment ${i}: ${turn}`);
    }
  }
});

test("2D and 3D projected morphology passes draw the same Neural ribbon profile", () => {
  const nodes = [
    { id: "a", position: { x: 0, y: 0, z: 0 }, radius: 7 },
    { id: "b", position: { x: 150, y: 0, z: 0 }, radius: 7 },
  ];
  const geometry = buildMorphologyGeometry("neural", nodes, [{ id: "ab", source: "a", target: "b", width: 1 }]);
  const style: MorphologyCanvasStyle = {
    fieldColor: "rgb(0, 0, 0)", nodes: new Map(nodes.map(node => [node.id, { color: "rgb(200, 200, 200)" }])),
    edges: new Map([["ab", { color: "rgb(200, 200, 200)" }]]),
  };
  const draw = (projection: "2d" | "3d", zoom = 1, edgeWidth = 1) => {
    const path: number[][] = [];
    const context = {
      canvas: { width: 400, height: 300, getBoundingClientRect: () => ({ width: 400, height: 300 }) },
      setTransform() {}, setLineDash() {}, clearRect() {}, beginPath() {}, closePath() {}, fill() {}, stroke() {},
      moveTo(x: number, y: number) { path.push([x, y]); },
      lineTo(x: number, y: number) { path.push([x, y]); },
    } as unknown as CanvasRenderingContext2D;
    (globalThis as typeof globalThis & { __d070?: object }).__d070 = { hideNodes: true };
    try {
      drawMorphologyCanvas(context, geometry, point => ({ x: 100 + point.x * zoom, y: 100 + point.y * zoom, scale: zoom }),
        style, { ...DEFAULT_APPEARANCE, edgeWidth, glow: 0, flowIntensity: 0 }, [], projection);
    } finally { delete (globalThis as typeof globalThis & { __d070?: object }).__d070; }
    return path;
  };
  const two = draw("2d"), three = draw("3d");
  assert.ok(two.length > 40, "the ribbon uses the subdivided centre-line");
  assert.deepEqual(two, three);
  const shaftWidth = (path: number[][]) => {
    const count = path.length / 2, middle = Math.floor(count / 2);
    const left = path[middle]!, right = path[2 * count - 1 - middle]!;
    return Math.hypot(left[0]! - right[0]!, left[1]! - right[1]!);
  };
  for (const slider of [0.3, 1, 3]) {
    const atOne = draw("2d", 1, slider), atSix = draw("2d", 6, slider);
    assert.ok(Math.abs(shaftWidth(atOne) - slider) < 1e-6);
    assert.ok(Math.abs(shaftWidth(atSix) - slider) < 1e-6, "zoom cannot grow the shaft width");
    assert.deepEqual(atSix, draw("3d", 6, slider));
  }
});
