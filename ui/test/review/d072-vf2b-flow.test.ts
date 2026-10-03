import assert from "node:assert/strict";
import test from "node:test";
import { buildMorphologyGeometry } from "#engine/morphology-geometry.ts";
import { DEFAULT_APPEARANCE } from "#engine/presentation-options.ts";
import { drawFlowLayer } from "#render-common/morphology-canvas.ts";
import { setFlowMotionAllowed, setFlowNow } from "#render-common/flow.ts";

test("dense beam draws one cached strip per arc and reuses gradients on steady frames", () => {
  const counts: Record<string, number> = {};
  const count = (name: string) => { counts[name] = (counts[name] ?? 0) + 1; };
  class FakeOffscreenCanvas {
    width: number;
    height: number;
    constructor(width: number, height: number) { this.width = width; this.height = height; }
    getContext() {
      return {
        createRadialGradient() { count("radial"); return { addColorStop() {} }; },
        createLinearGradient() { count("spriteLinear"); return { addColorStop() {} }; },
        fillRect() { count("spriteFill"); },
        fillStyle: "",
      };
    }
  }
  const global = globalThis as typeof globalThis & { OffscreenCanvas?: typeof OffscreenCanvas };
  const original = global.OffscreenCanvas;
  global.OffscreenCanvas = FakeOffscreenCanvas as unknown as typeof OffscreenCanvas;
  const context = {
    canvas: { width: 1200, height: 800, getBoundingClientRect: () => ({ width: 600, height: 400 }) },
    globalAlpha: 1, globalCompositeOperation: "source-over", lineCap: "butt", lineJoin: "miter",
    beginPath() { count("beginPath"); }, moveTo() { count("moveTo"); }, lineTo() { count("lineTo"); },
    stroke() { count("stroke"); }, fill() { count("fill"); }, drawImage() { count("drawImage"); },
    save() {}, restore() {}, translate() {}, rotate() {},
    createLinearGradient() { count("linear"); return { addColorStop() {} }; },
    createRadialGradient() { count("contextRadial"); return { addColorStop() {} }; },
  } as unknown as CanvasRenderingContext2D;
  const nodes = Array.from({ length: 60 }, (_, index) => ({
    id: `node-${index}`, position: { x: index % 2 ? 180 : 0, y: Math.floor(index / 2) * 10, z: 0 }, radius: 3,
  }));
  const edges = Array.from({ length: 30 }, (_, index) => ({
    id: `edge-${index}`, source: `node-${index * 2}`, target: `node-${index * 2 + 1}`, width: 1,
  }));
  const geometry = buildMorphologyGeometry("stellar", nodes, edges);
  const style = {
    fieldColor: "rgb(0, 0, 0)", nodes: new Map(),
    edges: new Map(edges.map(edge => [edge.id, { color: "rgb(181, 204, 245)",
      presentation: { category: "exploratory" as const, opacityPermille: 1000, widthPermille: 1000 } }])),
  };
  const project = (point: { x: number; y: number }) => ({ x: point.x + 40, y: point.y + 40, scale: 1 });
  const appearance = { ...DEFAULT_APPEARANCE, flowIntensity: 0.6, flowSpeed: 1 };
  try {
    setFlowMotionAllowed(true);
    setFlowNow(500);
    drawFlowLayer(context, geometry, project, style, appearance);
    const first = { ...counts };
    assert.equal(first.stroke ?? 0, 0, "dense flow uses cached tail images without any per-arc stroke");
    assert.equal(first.beginPath ?? 0, 0);
    assert.ok((first.drawImage ?? 0) >= 25 && (first.drawImage ?? 0) <= 30,
      "dense flow draws one elongated beam strip per arc");
    assert.ok((first.moveTo ?? 0) <= 60 && (first.lineTo ?? 0) <= 240,
      "path commands scale with visible arcs and their bends");
    assert.equal(first.linear ?? 0, 0);
    assert.equal(first.contextRadial ?? 0, 0);
    assert.equal(first.radial ?? 0, 0, "the beam has no bright radial dot");
    assert.ok((first.spriteLinear ?? 0) > 0, "the first frame builds a quantised tail gradient once");

    for (const key of Object.keys(counts)) counts[key] = 0;
    setFlowNow(900);
    drawFlowLayer(context, geometry, project, style, appearance);
    assert.equal(counts.stroke ?? 0, 0);
    assert.equal(counts.beginPath ?? 0, 0);
    assert.equal(counts.radial ?? 0, 0, "a steady second frame makes no gradient");
    assert.equal(counts.spriteLinear ?? 0, 0);
    assert.equal(counts.linear ?? 0, 0);
    assert.equal(counts.contextRadial ?? 0, 0);
    assert.equal(counts.fill ?? 0, 0);
    assert.equal(counts.spriteFill ?? 0, 0);

    for (const key of Object.keys(counts)) counts[key] = 0;
    const smallStyle = { ...style, edges: new Map([...style.edges].slice(0, 5)) };
    drawFlowLayer(context, geometry, project, smallStyle, appearance);
    assert.equal(counts.stroke, 2, "five arcs share one stroke per tail band");
    assert.equal(counts.beginPath, 2);
    assert.ok((counts.moveTo ?? 0) <= 10 && (counts.lineTo ?? 0) <= 40);
  } finally {
    setFlowMotionAllowed(false);
    global.OffscreenCanvas = original;
  }
});
