import test from 'node:test';
import assert from 'node:assert/strict';
import { drawCanopyEvidenceFlow, type CanopyFlowStroke } from '../src/fractal/renderer-adapter.ts';
import { FLOW_ANIMATED_EDGE_BUDGET, FLOW_BEAM_WHITE_MIX } from '#render-common/flow.ts';
// D086-F3 BEGIN
import { PALETTES } from '../src/review/palette.ts';
// D086-F3 END

// D086-F5 BEGIN: the D-079 approved beam belongs to real exploratory evidence,
// never to Canopy's generated structural rails or attested relations.
function recordingContext() {
  const strokes: { from: number[]; to: number[]; stops: { at: number; ink: string }[] }[] = [];
  let from: number[] = [], to: number[] = [];
  let stops: { at: number; ink: string }[] = [];
  const context = {
    createLinearGradient() { stops = []; return { addColorStop(at: number, ink: string) { stops.push({ at, ink }); } }; },
    beginPath() { from = []; to = []; }, moveTo(x: number, y: number) { from = [x, y]; },
    lineTo(x: number, y: number) { to = [x, y]; },
    stroke() { strokes.push({ from, to, stops }); },
    lineWidth: 0, lineCap: 'butt', strokeStyle: '',
  } as unknown as CanvasRenderingContext2D;
  return { context, strokes };
}
const stroke = (id: string, klass: 'attested' | 'exploratory', y: number): CanopyFlowStroke => ({
  edge: { id, source: `a:${id}`, target: `b:${id}`, class: klass, count: 1 },
  from: { x: 0, y }, to: { x: 300, y },
});

test('Canopy Attestata animates no evidence and Combinata only real exploratory evidence', () => {
  const rows = [stroke('att', 'attested', 10), stroke('exp', 'exploratory', 20)];
  const attested = recordingContext();
  assert.equal(drawCanopyEvidenceFlow(attested.context, rows, 'attested', 4000, 1, 0.6), 0);
  assert.equal(attested.strokes.length, 0);
  for (const reading of ['exploratory', 'combined'] as const) {
    const drawn = recordingContext();
    assert.equal(drawCanopyEvidenceFlow(drawn.context, rows, reading, 4000, 1, 0.6), 1);
    assert.equal(drawn.strokes.length, 1);
    assert.deepEqual(drawn.strokes[0]!.from, [0, 20]);
  }
});

test('Canopy beam is paced by its caller, moves slowly, and never exceeds the shared edge budget', () => {
  const rows = Array.from({ length: 100 }, (_, index) => stroke(`exp:${String(index).padStart(3, '0')}`, 'exploratory', index));
  const first = recordingContext(), later = recordingContext();
  assert.equal(drawCanopyEvidenceFlow(first.context, rows, 'exploratory', 3000, 1, 0.6), FLOW_ANIMATED_EDGE_BUDGET);
  assert.equal(first.strokes.length, FLOW_ANIMATED_EDGE_BUDGET);
  assert.equal(drawCanopyEvidenceFlow(later.context, rows, 'exploratory', 4000, 1, 0.6), FLOW_ANIMATED_EDGE_BUDGET);
  const peak = (stops: { at: number; ink: string }[]) => stops.reduce((best, row) =>
    Number(row.ink.match(/([\d.]+)\)$/)![1]) > Number(best.ink.match(/([\d.]+)\)$/)![1]) ? row : best).at;
  assert.ok(peak(later.strokes[0]!.stops) > peak(first.strokes[0]!.stops));
  const stopped = recordingContext();
  assert.equal(drawCanopyEvidenceFlow(stopped.context, rows, 'exploratory', 4000, 0, 0.6), 0);
  assert.equal(stopped.strokes.length, 0);
});
// D086-F5 BEGIN: Canopy's core follows the same edge-to-white mix as the Natural beam.
test('Canopy beam core follows the exploratory palette and the shared white law', () => {
  // D086-F3 BEGIN
  for (const [palette, base] of [[PALETTES.bw, [162, 162, 162]],
    [PALETTES.amber, [195, 158, 101]]] as const) {
    const drawn = recordingContext();
    drawCanopyEvidenceFlow(drawn.context, [stroke('exp', 'exploratory', 20)], 'exploratory', 4000, 1, 0.6, palette);
    const expected = base.map(channel => Math.round(channel + (255 - channel) * FLOW_BEAM_WHITE_MIX));
    const channels = drawn.strokes[0]!.stops[0]!.ink.match(/[\d.]+/g)!.slice(0, 3).map(Number);
    assert.deepEqual(channels, expected);
    assert.equal(channels[0] === channels[1] && channels[1] === channels[2], palette === PALETTES.bw);
  }
  // D086-F3 END
});
// D086-F5 END
// D086-F5 END
