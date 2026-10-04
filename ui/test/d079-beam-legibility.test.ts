import assert from 'node:assert/strict';
import test from 'node:test';
import { buildMorphologyGeometry } from '#engine/morphology-geometry.ts';
import { DEFAULT_APPEARANCE } from '#engine/presentation-options.ts';
import { drawFlowLayer } from '#render-common/morphology-canvas.ts';
import {
  FLOW_ANIMATED_EDGE_BUDGET, FLOW_BEAM_GLOW_ALPHA, FLOW_HEAD_SPEED_PX_S,
  flowAnimates, flowBeamLengthPx, flowBeamWidthsPx, flowHeadAlpha,
  setFlowMotionAllowed, setFlowNow,
} from '#render-common/flow.ts';

test('thin and thick exploratory filaments keep a visible core within the ribbon caps', () => {
  for (const filament of [0.5, 0.75, 1, 3, 6]) {
    const { core, glow } = flowBeamWidthsPx(filament);
    assert.ok(core >= 1.5 && core <= Math.max(2, filament * 1.35), `${filament}px core`);
    assert.ok(glow >= core && glow <= Math.max(5, filament * 2.5), `${filament}px glow`);
  }
  assert.ok(flowHeadAlpha(0.6) * 248 / 255 >= 0.6, 'full core has at least 60% luminance on black');
  assert.ok(FLOW_BEAM_GLOW_ALPHA <= 0.12, 'the wide halo remains faint');
  assert.ok(FLOW_HEAD_SPEED_PX_S <= 36 && flowBeamLengthPx(240) >= 100);
  assert.equal(FLOW_ANIMATED_EDGE_BUDGET, 60);
});

test('reduced motion leaves the travelling layer empty', () => {
  assert.equal(flowAnimates({ intensity: 1, speed: 1, motionEnabled: true, reducedMotion: true }), false);
  const geometry = buildMorphologyGeometry('stellar', [
    { id: 'a', position: { x: 0, y: 0, z: 0 }, radius: 4 },
    { id: 'b', position: { x: 120, y: 0, z: 0 }, radius: 4 },
  ], [{ id: 'ab', source: 'a', target: 'b', width: 1 }]);
  let strokes = 0;
  const context = {
    canvas: { width: 200, height: 100, getBoundingClientRect: () => ({ width: 200, height: 100 }) },
    beginPath() {}, moveTo() {}, lineTo() {}, stroke() { strokes++; },
    globalAlpha: 1, globalCompositeOperation: 'source-over',
  } as unknown as CanvasRenderingContext2D;
  const style = { fieldColor: 'rgb(0, 0, 0)', nodes: new Map(), edges: new Map([['ab', {
    color: 'rgb(220, 220, 220)', presentation: {
      category: 'exploratory' as const, opacityPermille: 1000, widthPermille: 1000,
    },
  }]]) };
  setFlowNow(3000);
  setFlowMotionAllowed(false);
  drawFlowLayer(context, geometry, point => ({ x: point.x + 20, y: point.y + 40, scale: 1 }),
    style, { ...DEFAULT_APPEARANCE, flowIntensity: 1, flowSpeed: 1 });
  assert.equal(strokes, 0);
});

test('the full-width travelling wave bends with a Mycelium arc rather than crossing its chord', () => {
  const geometry = buildMorphologyGeometry('mycelium', [
    { id: 'a', position: { x: 0, y: 0, z: 0 }, radius: 4 },
    { id: 'b', position: { x: 200, y: 0, z: 0 }, radius: 4 },
  ], [{ id: 'ab', source: 'a', target: 'b', width: 1 }]);
  const lineY: number[] = [];
  const context = {
    canvas: { width: 300, height: 120, getBoundingClientRect: () => ({ width: 300, height: 120 }) },
    beginPath() {}, moveTo() {}, lineTo(_x: number, y: number) { lineY.push(y); }, closePath() {}, fill() {},
    createLinearGradient() { return { addColorStop() {} }; },
    globalAlpha: 1, globalCompositeOperation: 'source-over', lineCap: 'round', lineJoin: 'round',
  } as unknown as CanvasRenderingContext2D;
  const style = { fieldColor: 'rgb(0, 0, 0)', nodes: new Map(), edges: new Map([['ab', {
    color: 'rgb(220, 220, 220)', presentation: {
      category: 'exploratory' as const, opacityPermille: 1000, widthPermille: 1000,
    },
  }]]) };
  try {
    setFlowMotionAllowed(true);
    setFlowNow(5000);
    drawFlowLayer(context, geometry, point => ({ x: point.x + 20, y: point.y + 40, scale: 1 }),
      style, { ...DEFAULT_APPEARANCE, flowIntensity: 1, flowSpeed: 1 });
    assert.ok(lineY.length > 2);
    assert.ok(lineY.some(y => Math.abs(y - 40) > 2), 'drawn segments retain the wave away from the chord');
  } finally { setFlowMotionAllowed(false); }
});
