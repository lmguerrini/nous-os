import assert from "node:assert/strict";
import test from "node:test";
import { neuralScreenWidthAt } from "#engine/morphology-geometry.ts";
import { neuralEdgeDensity, neuralRootInsideSoma, somaLobeFactor, somaOutlineRadiusAtAngle,
  type NeuralSomaFrame } from "#render-common/morphology-canvas.ts";
import { flowWaveAlpha, FLOW_WAVE_MAX_ALPHA, FLOW_WAVE_PERIOD_LENGTHS } from "#render-common/flow.ts";
import { FILAMENT_FRAGMENT_SHADER } from "#render3f/filament-material.ts";
import { NODE_FRAGMENT_SHADER } from "#render3f/node-material.ts";

test("connected lobes make a closed soma outline and roots begin inside it", () => {
  const frame: NeuralSomaFrame = { x: 20, y: 30, angle: 0, radius: 8, eccentricity: 1.4,
    harmonics: [], spindle: true, lobes: [{ angle: 0, strength: 0.3 }, { angle: 1.8, strength: 0.15 }] };
  assert.ok(somaLobeFactor(frame.lobes!, 0) > somaLobeFactor(frame.lobes!, Math.PI));
  assert.ok(somaOutlineRadiusAtAngle(frame, 0) > somaOutlineRadiusAtAngle(frame, Math.PI));
  for (let i = 0; i < 360; i++) {
    const angle = i * Math.PI / 180;
    const root = neuralRootInsideSoma(frame, { x: frame.x + 100 * Math.cos(angle), y: frame.y + 100 * Math.sin(angle) });
    assert.ok(Math.hypot(root.x - frame.x, root.y - frame.y) < somaOutlineRadiusAtAngle(frame, angle));
  }
  assert.ok(Math.abs(somaOutlineRadiusAtAngle(frame, 0) - somaOutlineRadiusAtAngle(frame, 2 * Math.PI)) < 1e-9);
});

test("root taper and edge density are continuous and contain the exploratory light", () => {
  const widths = Array.from({ length: 101 }, (_, i) => neuralScreenWidthAt(i / 100, 2, 8, 8, [2.6, 2.6], 160, true));
  assert.ok(widths[0]! > widths[20]!);
  for (let i = 1; i <= 20; i++) assert.ok(widths[i]! <= widths[i - 1]! + 1e-9);
  let previous = neuralEdgeDensity(0);
  for (let i = 1; i <= 1000; i++) {
    const density = neuralEdgeDensity(i / 1000);
    assert.ok(density <= previous + 1e-12 && previous - density < 0.01);
    previous = density;
  }
  assert.equal(neuralEdgeDensity(1), 0);
  for (let along = 0; along <= 100; along++) {
    const light = flowWaveAlpha(along, 100, 400, 1, 0.6);
    assert.ok(light >= 0 && light <= FLOW_WAVE_MAX_ALPHA);
    for (let radial = 0; radial <= 1; radial += 0.05)
      assert.ok(neuralEdgeDensity(radial) * light <= neuralEdgeDensity(radial) + 1e-12);
  }
  assert.match(FILAMENT_FRAGMENT_SHADER, /float radial = 1\.0 - smoothstep\(0\.0, 1\.0, distance \/ max\(bodyHalfWidth, feather\)\)/);
  assert.match(FILAMENT_FRAGMENT_SHADER, /outputColor = vec4\(color \* alpha, alpha\)/);
  assert.match(FILAMENT_FRAGMENT_SHADER, /pulseDistance < pulseHalfParameter/);
  assert.match(FILAMENT_FRAGMENT_SHADER, /0\.5 \+ 0\.5 \* cos\(3\.14159265 \* pulseDistance \/ pulseHalfParameter\)/);
  assert.match(NODE_FRAGMENT_SHADER, /rootLobe/);
});

test("one long wave keeps a continuous edge with at most one still-frame maximum", () => {
  assert.ok(FLOW_WAVE_PERIOD_LENGTHS >= 1);
  for (const length of [12, 60, 240, 1000]) for (const now of [0, 400, 1400, 4200, 12000]) {
    const samples = Array.from({ length: 1001 }, (_, index) =>
      flowWaveAlpha(length * index / 1000, length, now, 1, 0.8));
    const maxima = samples.slice(1, -1).filter((value, index) =>
      value > samples[index]! && value >= samples[index + 2]!).length;
    assert.ok(maxima <= 1, `length=${length} time=${now}: ${maxima} peaks`);
    for (let index = 1; index < samples.length; index++)
      assert.ok(Math.abs(samples[index]! - samples[index - 1]!) < 0.03);
    assert.ok(samples.every(value => value >= 0 && value <= FLOW_WAVE_MAX_ALPHA));
  }
  assert.equal(flowWaveAlpha(40, 100, 800, 1, 0), 0);
  assert.equal(flowWaveAlpha(40, 100, 800, 0, 1), 0);
});
