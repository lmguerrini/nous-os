import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { canopyHyphaOffset, canopyJunctionOutline, canopyMorphologyWidth,
  canopySmoothControls, paintMyceliumRail, paintNeuralRail } from '../src/fractal/renderer-adapter.ts';

const morphologies = ['stellar', 'neural', 'mycelium'] as const;

function polygonCovers(x: number, y: number, polygon: readonly Readonly<{ x: number; y: number }>[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i]!, b = polygon[j]!;
    if ((a.y > y) !== (b.y > y) && x < (b.x - a.x) * (y - a.y) / (b.y - a.y) + a.x)
      inside = !inside;
  }
  return inside;
}

function railCoverage(morphology: typeof morphologies[number]): number {
  const width = canopyMorphologyWidth(3, morphology);
  let covered = 0;
  for (let x = 0; x < 160; x++) for (let y = -48; y <= 48; y++) {
    const t = (x + 0.5) / 160;
    const ordinate = y / 8;
    const on = morphology === 'stellar' ? Math.abs(ordinate) < width / 2
      : morphology === 'neural' ? Math.abs(ordinate) < width * (1.42 - t * 0.78) / 2
        : [-1, 0, 1].some(lane => Math.abs(ordinate - canopyHyphaOffset(t, lane, 2.4))
          < (lane === 0 ? width : Math.max(0.58, width * 0.72)) / 2);
    if (on) covered++;
  }
  return covered / 160 / 8;
}

function junctionCoverage(morphology: typeof morphologies[number]): number {
  const radius = morphology === 'stellar' ? 3.4 : morphology === 'neural' ? 4.8 : 1.3;
  const outline = canopyJunctionOutline(radius, morphology, Math.PI / 6);
  let covered = 0;
  for (let x = -60; x <= 60; x++) for (let y = -60; y <= 60; y++)
    if (polygonCovers(x / 10, y / 10, outline)) covered++;
  return covered / 100;
}

test('P7e fit morphology ink has at least 40% pairwise coverage separation', () => {
  const widths = morphologies.map(railCoverage);
  const areas = morphologies.map(junctionCoverage);
  console.info(`P7e fit coverage: ${morphologies.map((m, i) =>
    `${m} rail ${widths[i]!.toFixed(2)}px / junction ${areas[i]!.toFixed(2)}px²`).join(', ')}`);
  for (let i = 0; i < 3; i++) for (let j = i + 1; j < 3; j++) {
    assert.ok(Math.max(widths[i]!, widths[j]!) / Math.min(widths[i]!, widths[j]!) >= 1.4,
      `${morphologies[i]} / ${morphologies[j]} rail coverage ${widths}`);
    assert.ok(Math.max(areas[i]!, areas[j]!) / Math.min(areas[i]!, areas[j]!) >= 1.4,
      `${morphologies[i]} / ${morphologies[j]} junction coverage ${areas}`);
  }
  assert.ok(widths[1]! > widths[2]! && widths[2]! > widths[0]!);
  assert.ok(areas[1]! > areas[0]! && areas[0]! > areas[2]!);
  for (const lane of [-1, 0, 1]) {
    assert.ok(Math.abs(canopyHyphaOffset(0, lane, 2.4)) < 1e-9);
    assert.ok(Math.abs(canopyHyphaOffset(1, lane, 2.4)) < 1e-9);
  }
});

test('P7e deep zoom canvas rail paint remains bounded in Node', () => {
  let operations = 0;
  const context = {
    beginPath() { operations++; }, moveTo() { operations++; }, lineTo() { operations++; },
    closePath() { operations++; }, fill() { operations++; }, stroke() { operations++; },
    fillStyle: '', strokeStyle: '', lineWidth: 1, lineCap: 'round', globalAlpha: 1,
  } as unknown as CanvasRenderingContext2D;
  const controls = canopySmoothControls([
    { x: 0, y: 0 }, { x: 14, y: 7 }, { x: 28, y: -6 }, { x: 42, y: 0 },
  ]);
  const times: number[] = [];
  for (const morphology of morphologies) {
    operations = 0;
    const started = performance.now();
    for (let i = 0; i < 1500; i++) {
      if (morphology === 'neural') paintNeuralRail(context, controls, 5.5, '#ddd');
      else if (morphology === 'mycelium') paintMyceliumRail(context, controls, 0.9, '#ddd');
      else { context.beginPath(); context.moveTo(0, 0); context.lineTo(42, 0); context.stroke(); }
    }
    times.push(performance.now() - started);
    assert.ok(operations < 1500 * 160, `${morphology} has bounded per-rail drawing work`);
  }
  assert.ok(times.every(Number.isFinite));
  console.info(`P7e Node canopy paint / 1,500 deep rails: ${morphologies.map((m, i) =>
    `${m} ${times[i]!.toFixed(1)}ms`).join(', ')}`);
});
