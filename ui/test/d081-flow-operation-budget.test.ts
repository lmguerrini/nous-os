import assert from "node:assert/strict";
import test from "node:test";
import { buildMorphologyGeometry } from "#engine/morphology-geometry.ts";
import { DEFAULT_APPEARANCE } from "#engine/presentation-options.ts";
import { clipEdgePaint, drawEdgeStaticCue, drawFlowLayer, drawNeuralProfile,
  type MorphologyEdgePaint } from "#render-common/morphology-canvas.ts";
import { setFlowMotionAllowed, setFlowNow } from "#render-common/flow.ts";

function recorder() {
  const counts = { gradients: 0, stops: 0, fills: 0, vertices: 0 };
  const canvas = { width: 1200, height: 800,
    getBoundingClientRect: () => ({ width: 600, height: 400 }) };
  const context = {
    canvas, globalCompositeOperation: "source-over", lineCap: "butt", lineJoin: "miter",
    fillStyle: "", beginPath() {}, moveTo() { counts.vertices++; },
    lineTo() { counts.vertices++; }, closePath() {}, fill() { counts.fills++; },
    createLinearGradient() { counts.gradients++; return { addColorStop() { counts.stops++; } }; },
  } as unknown as CanvasRenderingContext2D;
  return { counts, context };
}

function longPaint(neural: boolean, offset = 0): MorphologyEdgePaint {
  const points = Array.from({ length: 2001 }, (_, i) => ({ x: i * 10 - 10000 + offset, y: 200, scale: 1 }));
  return { part: {} as MorphologyEdgePaint["part"], edgeId: "long", category: "exploratory", neural,
    points, cumulative: points.map((_, i) => i * 10), totalPx: 20000,
    color: "rgb(200, 220, 240)", alpha: 0.6, widthAt: () => 3 };
}

test("approach-camera clipping bounds vertices and skips offscreen edges", () => {
  for (const neural of [false, true]) {
    const [visible] = clipEdgePaint(longPaint(neural), 600, 400);
    assert.ok(visible);
    assert.ok(visible.points.length <= 70, `visible ${neural} edge retained ${visible.points.length} vertices`);
    assert.ok(visible.cumulative[0]! > 9000 && visible.cumulative.at(-1)! < 11000);
    assert.equal(clipEdgePaint(longPaint(neural, 30000), 600, 400).length, 0);
    const { counts, context } = recorder();
    drawNeuralProfile(context, { ...visible, neural: true });
    drawEdgeStaticCue(context, visible, 0.6, true);
    assert.ok(counts.fills <= 3 && counts.gradients <= 0 && counts.stops <= 0,
      `static edge budget: ${JSON.stringify(counts)}`);
    assert.ok(counts.vertices <= 4 * 2 * 70, `vertex budget: ${counts.vertices}`);
  }
});

test("20,000 px Mycelium, Stellar and Neural flow overlays have constant canvas operations", t => {
  const appearance = { ...DEFAULT_APPEARANCE, flowIntensity: 0.6, flowSpeed: 1 };
  try {
    setFlowMotionAllowed(true);
    setFlowNow(313000);
    for (const morphology of ["mycelium", "stellar", "neural"] as const) for (const projection of ["2d", "3d"] as const) {
      const nodes = [
        { id: "a", position: { x: -10, y: 0, z: 0 }, radius: 3 },
        { id: "b", position: { x: 10, y: 0, z: 0 }, radius: 3 },
      ];
      const geometry = buildMorphologyGeometry(morphology, nodes,
        [{ id: "e", source: "a", target: "b", width: 1 }]);
      const style = { fieldColor: "rgb(0, 0, 0)", nodes: new Map(),
        edges: new Map([["e", { color: "rgb(200, 220, 240)", presentation: {
          category: "exploratory" as const, opacityPermille: 1000, widthPermille: 1000,
        } }]]) };
      const project = (point: { x: number; y: number }) =>
        ({ x: point.x * 1000 + 300, y: point.y * 50 + 200, scale: 1 });
      const { context, counts } = recorder();
      drawFlowLayer(context, geometry, project, style, appearance, projection);
      assert.ok(counts.fills > 0, `${morphology} ${projection}: long crossing edge was skipped`);
      assert.ok(counts.fills <= 4 && counts.gradients <= 4 && counts.stops <= 80
        && counts.vertices <= 1024, `${morphology} ${projection}: ${JSON.stringify(counts)}`);
      t.diagnostic(`${morphology} ${projection}: ${JSON.stringify(counts)}`);
    }
  } finally { setFlowMotionAllowed(false); }
});
