import test from "node:test";
import assert from "node:assert/strict";
import { buildMorphologyGeometry } from "#engine/morphology-geometry.ts";
import { drawMorphologyCanvas } from "#render-common/morphology-canvas.ts";
import {
  EDGE_CATEGORIES,
  FLOW_ANIMATED_EDGE_BUDGET,
  FLOW_PERIOD_MS,
  classifyEdgeCategory,
  flowAnimates,
  flowPhaseAt,
  flowPulseAlpha,
  selectFlowEdges,
} from "#render-common/flow.ts";

const nodes = [
  { id: "a", position: { x: 0, y: 0, z: 0 }, radius: 5 },
  { id: "b", position: { x: 100, y: 0, z: 0 }, radius: 5 },
  { id: "c", position: { x: 100, y: 100, z: 0 }, radius: 5 },
];
const edges = [
  { id: "ab", source: "a", target: "b", width: 1 },
  { id: "bc", source: "b", target: "c", width: 1 },
];

function recordingContext() {
  const dash: number[][] = [];
  let fills = 0;
  let strokes = 0;
  const context = {
    canvas: { width: 400, height: 300, getBoundingClientRect: () => ({ width: 400, height: 300 }) },
    setTransform() {}, clearRect() {},
    setLineDash(pattern: number[]) { dash.push(pattern.slice()); },
    beginPath() {}, moveTo() {}, lineTo() {}, closePath() {},
    stroke() { strokes++; }, fill() { fills++; },
    arc() {}, ellipse() {}, fillText() {}, measureText: () => ({ width: 0 }),
    createRadialGradient: () => ({ addColorStop() {} }),
    lineCap: "butt", lineJoin: "miter", strokeStyle: "", fillStyle: "", lineWidth: 1, globalAlpha: 1, globalCompositeOperation: "source-over",
  } as unknown as CanvasRenderingContext2D;
  return { context, dash, fills: () => fills, strokes: () => strokes };
}

const project = (point: { x: number; y: number; z: number }) => ({ x: point.x + 50, y: point.y + 50, scale: 1 });

test("no presentation produces a dash array", () => {
  const geometry = buildMorphologyGeometry("stellar", nodes, edges);
  const { context, dash } = recordingContext();
  drawMorphologyCanvas(context, geometry, project, {
    fieldColor: "rgb(0, 0, 0)",
    nodes: new Map(),
    edges: new Map([
      ["ab", { color: "rgb(220, 220, 220)", presentation: { category: "attested" as const, opacityPermille: 1000, widthPermille: 1000 } }],
      ["bc", { color: "rgb(220, 220, 220)", presentation: { category: "exploratory" as const, opacityPermille: 1000, widthPermille: 1000 } }],
    ]),
  });
  assert.ok(dash.every((pattern) => pattern.length === 0), `expected only empty dash arrays, got ${JSON.stringify(dash)}`);
});

test("every edge resolves to a category; an uncategorised edge is not drawn", () => {
  for (const exploratory of [false, true]) for (const containment of [false, true]) {
    const category = classifyEdgeCategory(exploratory, containment);
    assert.ok((EDGE_CATEGORIES as readonly string[]).includes(category), `no category for exploratory=${exploratory} containment=${containment}`);
  }
  assert.deepEqual([...EDGE_CATEGORIES].sort(), ["attested", "containment", "exploratory"]);

  const geometry = buildMorphologyGeometry("stellar", nodes, edges);
  const { context, fills } = recordingContext();
  (globalThis as typeof globalThis & { __d070?: object }).__d070 = { hideNodes: true };
  try {
    drawMorphologyCanvas(context, geometry, project, {
      fieldColor: "rgb(0, 0, 0)",
      nodes: new Map(),
      edges: new Map([
        ["ab", { color: "rgb(220, 220, 220)", presentation: { category: "attested" as const, opacityPermille: 1000, widthPermille: 1000 } }],
        ["bc", { color: "rgb(220, 220, 220)", presentation: { category: "bogus" as never, opacityPermille: 1000, widthPermille: 1000 } }],
      ]),
    });
  } finally {
    delete (globalThis as typeof globalThis & { __d070?: object }).__d070;
  }
  assert.equal(fills(), 1, "only the categorised edge is drawn");
});

test("the flow phase is deterministic for a given time", () => {
  assert.equal(flowPhaseAt(0, 1), 0);
  assert.equal(flowPhaseAt(FLOW_PERIOD_MS, 1), 0);
  assert.equal(flowPhaseAt(FLOW_PERIOD_MS / 2, 1), 0.5);
  assert.equal(flowPhaseAt(1234, 1), flowPhaseAt(1234, 1));
  assert.equal(flowPhaseAt(1234, 0), 0);
  assert.equal(flowPhaseAt(-1, 1), flowPhaseAt(-1, 1));
  assert.ok(flowPhaseAt(999999, 0.7) >= 0 && flowPhaseAt(999999, 0.7) < 1);
});

test("reduced motion requests no animation frames", () => {
  assert.equal(flowAnimates({ intensity: 0.6, speed: 1, motionEnabled: true, reducedMotion: true }), false);
  assert.equal(flowAnimates({ intensity: 0.6, speed: 1, motionEnabled: false, reducedMotion: false }), false);
  assert.equal(flowAnimates({ intensity: 0, speed: 1, motionEnabled: true, reducedMotion: false }), false);
  assert.equal(flowAnimates({ intensity: 0.6, speed: 0, motionEnabled: true, reducedMotion: false }), false);
  assert.equal(flowAnimates({ intensity: 0.6, speed: 1, motionEnabled: true, reducedMotion: false }), true);
});

test("the pulse is bounded, still without intensity and symmetric across the loop", () => {
  assert.equal(flowPulseAlpha(0.5, 0.5, 0), 0);
  assert.ok(flowPulseAlpha(0.5, 0.5, 0.8) > 0);
  assert.ok(flowPulseAlpha(0.001, 0.5, 1) <= 1);
  assert.equal(flowPulseAlpha(0.02, 0.5, 1), flowPulseAlpha(0.98, 0.5, 1));
});

test("the animation budget caps edges and favours the selected and focus-adjacent ones", () => {
  const many = Array.from({ length: 200 }, (_, i) => ({ edgeId: `e${i}`, visible: true, priority: 2 }));
  const selected = { edgeId: "selected", visible: true, priority: 0 };
  const near = { edgeId: "near", visible: true, priority: 1 };
  const hidden = { edgeId: "hidden", visible: false, priority: 0 };
  const chosen = selectFlowEdges([hidden, ...many, selected, near]);
  assert.ok(chosen.size <= FLOW_ANIMATED_EDGE_BUDGET);
  assert.ok(chosen.has("selected"));
  assert.ok(chosen.has("near"));
  assert.ok(!chosen.has("hidden"));
  // Deterministic: same candidates, same selection.
  assert.deepEqual([...selectFlowEdges([hidden, ...many, selected, near])].sort(), [...chosen].sort());
});
