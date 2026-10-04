import assert from "node:assert/strict";
import test from "node:test";
import { neuralScreenWidthAt } from "#engine/morphology-geometry.ts";
import { neuralEdgeDensity, neuralFlowModulation, neuralRootInsideSoma, somaLobeFactor, somaOutlineRadiusAtAngle,
  type NeuralSomaFrame } from "#render-common/morphology-canvas.ts";
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
  for (let along = -5; along <= 105; along++) {
    const light = neuralFlowModulation(along, 100, 0.6);
    assert.ok(light >= 0 && light <= 0.6);
    for (let radial = 0; radial <= 1; radial += 0.05)
      assert.ok(neuralEdgeDensity(radial) * light <= neuralEdgeDensity(radial) + 1e-12);
  }
  assert.match(FILAMENT_FRAGMENT_SHADER, /float radial = 1\.0 - smoothstep\(0\.0, 1\.0, distance \/ max\(bodyHalfWidth, feather\)\)/);
  assert.match(FILAMENT_FRAGMENT_SHADER, /outputColor = vec4\(color \* alpha, alpha\)/);
  assert.match(NODE_FRAGMENT_SHADER, /rootLobe/);
});
