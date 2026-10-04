import assert from "node:assert/strict";
import test from "node:test";
import { drawEdgeStaticCue, drawNeuralLight, drawNeuralProfile, neuralRibbonProfile,
  type MorphologyEdgePaint } from "#render-common/morphology-canvas.ts";
import { flowWaveAlpha } from "#render-common/flow.ts";

type Point = { x: number; y: number };
type Gradient = { stops: { at: number; alpha: number }[] };
type Fill = { path: Point[]; style: string | Gradient };
const alphaOf = (color: string): number => Number(color.match(/,\s*([\d.]+)\s*\)$/)?.[1] ?? NaN);

/** Canvas recorder + polygon rasterizer: one path is one fill, and source-over alpha composes
 * the concentric premultiplied-alpha ribbons exactly as the browser does away from AA pixels. */
function recordingCanvas() {
  const fills: Fill[] = [];
  let path: Point[] = [];
  const context = {
    fillStyle: "",
    beginPath() { path = []; }, moveTo(x: number, y: number) { path.push({ x, y }); },
    lineTo(x: number, y: number) { path.push({ x, y }); }, closePath() {},
    fill() { fills.push({ path: [...path], style: this.fillStyle }); },
    createLinearGradient() {
      const gradient: Gradient = { stops: [] };
      return Object.assign(gradient, { addColorStop(at: number, color: string) {
        gradient.stops.push({ at, alpha: alphaOf(color) });
      } });
    },
  };
  return { fills, context: context as unknown as CanvasRenderingContext2D };
}

function inside(path: Point[], x: number, y: number): boolean {
  let hit = false;
  for (let i = 0, j = path.length - 1; i < path.length; j = i++) {
    const a = path[i]!, b = path[j]!;
    if ((a.y > y) !== (b.y > y) && x < (b.x - a.x) * (y - a.y) / (b.y - a.y) + a.x) hit = !hit;
  }
  return hit;
}

function coverage(fills: Fill[], x: number, y: number): number {
  let alpha = 0;
  for (const fill of fills) {
    if (!inside(fill.path, x, y)) continue;
    const value = typeof fill.style === "string" ? alphaOf(fill.style) : (() => {
      const stops = fill.style.stops;
      const t = Math.max(0, Math.min(1, x / 200));
      const index = Math.min(stops.length - 2, Math.floor(t * (stops.length - 1)));
      const a = stops[index]!, b = stops[index + 1]!;
      return a.alpha + (b.alpha - a.alpha) * (t - a.at) / (b.at - a.at);
    })();
    alpha = 1 - (1 - alpha) * (1 - value);
  }
  return alpha;
}

function paint(widthAt: (i: number) => number, curved = false): MorphologyEdgePaint {
  const points = Array.from({ length: 21 }, (_, i) => ({ x: i * 10,
    y: curved ? 50 + 7 * Math.sin(Math.PI * i / 20) : 50, scale: 1 }));
  const cumulative = [0];
  for (let i = 1; i < points.length; i++) cumulative.push(cumulative[i - 1]! +
    Math.hypot(points[i]!.x - points[i - 1]!.x, points[i]!.y - points[i - 1]!.y));
  return { part: {} as MorphologyEdgePaint["part"], edgeId: "e", category: "exploratory",
    neural: true, points, cumulative, totalPx: cumulative.at(-1)!, color: "rgb(220, 220, 220)",
    alpha: 0.8, widthAt, detailStartPx: 0, detailEndPx: 0 };
}

test("still Neural edges and the separate light layer remain continuous and centre-peaked", () => {
  for (const edge of [paint(() => 1.6), paint(i => 3 + 6 * Math.max(0, 1 - i / 5), true)]) {
    const { context, fills } = recordingCanvas();
    drawNeuralProfile(context, edge);
    const baseFills = fills.length;
    const baseSamples = Array.from({ length: 201 }, (_, x) =>
      coverage(fills, x, edge.points[10]!.y === 50 ? 50 : 50 + 7 * Math.sin(Math.PI * x / 200)));
    drawNeuralLight(context, edge, d => flowWaveAlpha(d, edge.totalPx, 400, 1, 0.8));
    assert.ok(baseFills <= 2 && fills.length - baseFills <= 2,
      `one pass used ${baseFills} base and ${fills.length - baseFills} light fills`);
    assert.ok(fills.every(fill => fill.path.length === edge.points.length * 2));
    for (let i = 15; i < baseSamples.length - 15; i++) {
      const nearby = Math.max(...baseSamples.slice(i - 15, i + 16));
      assert.ok(baseSamples[i]! >= nearby * 0.85, `dash in base edge at x=${i}`);
    }
    const centre = edge.points[10]!.y;
    let previous = coverage(fills, 100, centre);
    for (let offset = 0.25; offset <= 5; offset += 0.25) {
      const next = coverage(fills, 100, centre + offset);
      assert.ok(next <= previous + 1e-12, `hollow/rim at offset ${offset}`);
      previous = next;
    }
  }
});

test("profile samples composite monotonically and reduced-motion cue stays uniform", () => {
  assert.deepEqual(neuralRibbonProfile(1.9), [{ width: 1, alpha: 1 }]);
  assert.deepEqual(neuralRibbonProfile(3), [{ width: 1, alpha: 0.6 }, { width: 0.62, alpha: 0.4 }]);
  const edge = paint(() => 3);
  const { context, fills } = recordingCanvas();
  drawNeuralProfile(context, edge);
  const outer = coverage(fills, 100, 1.2 + 50);
  const centre = coverage(fills, 100, 50);
  assert.ok(centre > outer && outer > 0);
  assert.ok(Math.abs(centre - (1 - (1 - 0.8 * 0.6) * (1 - 0.8 * 0.4))) < 1e-12);
  drawEdgeStaticCue(context, edge, 0.8, true);
  assert.equal(fills.length, 3);
  const cue = fills[2]!.style;
  assert.equal(typeof cue, "string");
});

test("travelling light preserves the base centre-to-half-width alpha ratio", () => {
  const edge = paint(() => 3);
  const { context, fills } = recordingCanvas();
  drawNeuralProfile(context, edge);
  const sampleY = 51.125;
  const baseRatio = coverage(fills, 100, 50) / coverage(fills, 100, sampleY);
  drawNeuralLight(context, edge, distance => flowWaveAlpha(distance, edge.totalPx, 3125, 1, 0.6));
  const litRatio = coverage(fills, 100, 50) / coverage(fills, 100, sampleY);
  assert.ok(Math.abs(litRatio / baseRatio - 1) <= 0.1,
    `light changed centre/half-width ratio ${baseRatio} → ${litRatio}`);
  assert.ok(coverage(fills, 100, sampleY) > coverage(fills.slice(0, 2), 100, sampleY) * 1.35,
    "the pulse must brighten the outer half-width too");
});

test("an inline pulse or static cue reuses the base profile's two fills", () => {
  const edge = paint(() => 3);
  const baseline = recordingCanvas();
  drawNeuralProfile(baseline.context, edge);
  const sampleY = 51.125;
  const baseRatio = coverage(baseline.fills, 100, 50) / coverage(baseline.fills, 100, sampleY);
  for (const modulation of [
    (distance: number) => flowWaveAlpha(distance, edge.totalPx, 3125, 1, 0.6),
    () => 0.28,
  ]) {
    const { context, fills } = recordingCanvas();
    drawNeuralProfile(context, edge, modulation);
    assert.equal(fills.length, 2);
    assert.ok(fills.every(fill => fill.style instanceof Object));
    const ratio = coverage(fills, 100, 50) / coverage(fills, 100, sampleY);
    assert.ok(Math.abs(ratio / baseRatio - 1) <= 0.1);
  }
});
