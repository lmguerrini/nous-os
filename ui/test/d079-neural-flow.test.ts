import assert from "node:assert/strict";
import test from "node:test";
import {
  FLOW_HEAD_SPEED_PX_S, FLOW_STATIC_CORE_ALPHA, flowBeamLengthPx, flowHeadPositionPx,
  flowHighlightAlpha, flowAnimates, flowLayerShouldRun, setFlowMotionAllowed,
} from "#render-common/flow.ts";
import { buildMorphologyGeometry } from "#engine/morphology-geometry.ts";
import { DEFAULT_APPEARANCE } from "#engine/presentation-options.ts";
import { drawMorphologyCanvas } from "#render-common/morphology-canvas.ts";

test("exploratory beam is slow, long and steadily bright across its interior", () => {
  assert.ok(FLOW_HEAD_SPEED_PX_S <= 36);
  const length = 240;
  const beam = flowBeamLengthPx(length);
  assert.ok(beam >= 100);
  assert.ok(FLOW_STATIC_CORE_ALPHA >= 0.45);
  const cycle = length + beam;
  const head = flowHeadPositionPx(4000, 1, cycle);
  assert.ok(head > 0 && head < length);
  assert.ok(flowHighlightAlpha(head - beam * 0.25, head, cycle, 1, beam) > 0.95);
  assert.ok(flowHighlightAlpha(head - beam * 0.65, head, cycle, 1, beam) > 0.95);
  assert.equal(flowHighlightAlpha(head + 1, head, cycle, 1, beam), 0);
});

test("reduced motion requests zero animation frames and retains a static cue", () => {
  const reduced = flowAnimates({ intensity: 1, speed: 1, motionEnabled: true, reducedMotion: true });
  assert.equal(reduced, false);
  assert.equal(flowLayerShouldRun({ allowed: reduced, hidden: false, animatedEdges: 10 }), false);
  assert.ok(FLOW_STATIC_CORE_ALPHA > 0);
  const nodes = [{ id: "a", position: { x: 0, y: 0, z: 0 }, radius: 5 },
    { id: "b", position: { x: 100, y: 0, z: 0 }, radius: 5 }];
  const geometry = buildMorphologyGeometry("stellar", nodes, [{ id: "ab", source: "a", target: "b", width: 1 }]);
  const strokes = (category: "attested" | "exploratory") => {
    let count = 0;
    const context = { canvas: { width: 200, height: 100, getBoundingClientRect: () => ({ width: 200, height: 100 }) },
      setTransform() {}, clearRect() {}, setLineDash() {}, beginPath() {}, moveTo() {}, lineTo() {}, closePath() {},
      arc() {}, ellipse() {}, fill() {}, stroke() { count++; }, fillText() {}, measureText: () => ({ width: 0 }),
      createRadialGradient: () => ({ addColorStop() {} }), globalAlpha: 1, globalCompositeOperation: "source-over",
    } as unknown as CanvasRenderingContext2D;
    drawMorphologyCanvas(context, geometry, point => ({ x: point.x + 30, y: point.y + 30, scale: 1 }), {
      fieldColor: "rgb(0, 0, 0)", nodes: new Map(), edges: new Map([["ab", { color: "rgb(220, 220, 220)",
        presentation: { category, opacityPermille: 1000, widthPermille: 1000 } }]]),
    }, { ...DEFAULT_APPEARANCE, starfieldDensity: 0, flowIntensity: 1 });
    return count;
  };
  setFlowMotionAllowed(false);
  assert.ok(strokes("exploratory") > strokes("attested"));
});
