import assert from "node:assert/strict";
import { test } from "node:test";
import { buildMorphologyGeometry } from "#engine/morphology-geometry.ts";
import { MORPHOLOGY_CONTRACT } from "#engine/morphology-contract.ts";
import { DEFAULT_APPEARANCE } from "#engine/presentation-options.ts";
import { drawMorphologyCanvas, neuralSomaFrames, type MorphologyCanvasStyle, type ProjectedPoint } from "#render-common/morphology-canvas.ts";

const nodes = [
  { id: "hub", position: { x: 0, y: 0, z: 0 }, radius: 8 },
  { id: "trunk", position: { x: 0, y: 0, z: 120 }, radius: 4 },
];
const edges = [{ id: "real-trunk", source: "hub", target: "trunk", width: 2 }];
const geometry = buildMorphologyGeometry("neural", nodes, edges);
const style: MorphologyCanvasStyle = {
  fieldColor: "rgb(10, 10, 14)",
  nodes: new Map(nodes.map(node => [node.id, { color: "rgb(214, 226, 244)" }])),
  edges: new Map(edges.map(edge => [edge.id, { color: "rgb(150, 160, 178)" }])),
};
const appearance = { ...DEFAULT_APPEARANCE, glow: 0, starfieldDensity: 0, starfieldBrightness: 0 };
const foreshortened3d = (point: { x: number; y: number; z: number }): ProjectedPoint =>
  ({ x: 160 + point.x + point.z * 0.12, y: 120 + point.y, scale: 0.55 });

test("3D Neural keeps a spindle along the projected strongest real trunk at node screen scale", () => {
  const frames = neuralSomaFrames(geometry, foreshortened3d, style, MORPHOLOGY_CONTRACT.neural, appearance, "3d");
  const hub = frames.get("hub");
  assert.ok(hub);
  assert.ok(hub.eccentricity >= 1.6 && hub.eccentricity <= 2.2, `soma ratio ${hub.eccentricity}`);
  assert.ok(Math.abs(hub.angle) < 1e-9, "the mostly depth-directed trunk projects horizontally");
  assert.equal(hub.radius, 8 * 0.55 * MORPHOLOGY_CONTRACT.neural.node.scale,
    "the spindle uses the existing projected node size");
  assert.equal(hub.spindle, true, "the soma outline and junction use the same spindle frame");
});

function operations(projection?: "2d" | "3d"): string {
  const ops: unknown[][] = [];
  const canvas = { width: 320, height: 240, getBoundingClientRect: () => ({ width: 320, height: 240 }) };
  const ctx = {
    canvas, globalAlpha: 1, globalCompositeOperation: "source-over", fillStyle: "", strokeStyle: "", lineWidth: 1,
    setTransform: (...args: unknown[]) => ops.push(["setTransform", ...args]),
    clearRect: (...args: unknown[]) => ops.push(["clearRect", ...args]),
    beginPath: () => ops.push(["beginPath"]), moveTo: (...args: unknown[]) => ops.push(["moveTo", ...args]),
    lineTo: (...args: unknown[]) => ops.push(["lineTo", ...args]), closePath: () => ops.push(["closePath"]),
    fill: () => ops.push(["fill", ctx.fillStyle, ctx.globalAlpha]),
    arc: (...args: unknown[]) => ops.push(["arc", ...args]),
    save: () => ops.push(["save"]), restore: () => ops.push(["restore"]),
    setLineDash: (...args: unknown[]) => ops.push(["setLineDash", ...args]),
    stroke: () => ops.push(["stroke", ctx.strokeStyle, ctx.lineWidth]),
  } as unknown as CanvasRenderingContext2D;
  const reducedStyle: MorphologyCanvasStyle = { ...style,
    interaction: { quality: "moving", hoverId: null, focusIds: null },
  };
  drawMorphologyCanvas(ctx, geometry, foreshortened3d, reducedStyle, appearance, [], projection ?? "2d");
  return JSON.stringify(ops);
}

test("2D Neural drawing remains byte-identical to the established default projection path", () => {
  assert.equal(operations(), operations("2d"));
});
