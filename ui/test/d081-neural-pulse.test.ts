import assert from "node:assert/strict";
import test from "node:test";
import { FLOW_HEAD_SPEED_PX_S, FLOW_WAVE_MAX_ALPHA, flowPulseLengthPx,
  flowWaveAlpha } from "#render-common/flow.ts";
import { FILAMENT_FRAGMENT_SHADER } from "#render3f/filament-material.ts";

test("a still exploratory edge has one smooth, compact light maximum", () => {
  assert.equal(FLOW_HEAD_SPEED_PX_S, 32);
  for (const length of [100, 200, 600]) {
    const width = flowPulseLengthPx(length);
    assert.ok(width >= 40 && width <= 120);
    const now = 3000;
    const samples = Array.from({ length: length + 1 }, (_, x) => flowWaveAlpha(x, length, now, 1, 0.6));
    const peaks = samples.slice(1, -1).filter((value, i) => value > samples[i]! && value >= samples[i + 2]!).length;
    assert.ok(peaks <= 1, `${length}px edge has ${peaks} light maxima`);
    assert.ok(samples.every(value => value >= 0 && value <= FLOW_WAVE_MAX_ALPHA));
    for (let i = 1; i < samples.length; i++)
      assert.ok(Math.abs(samples[i]! - samples[i - 1]!) < 0.08, `abrupt step at ${i}`);
  }
  assert.match(FILAMENT_FRAGMENT_SHADER, /float pulseLengthPx = clamp\(span \/ u_devicePixelRatio \* 0\.2, 40\.0, 120\.0\)/);
  assert.match(FILAMENT_FRAGMENT_SHADER, /mod\(u_flowElapsedMs \* 0\.032 \* u_devicePixelRatio/);
  assert.match(FILAMENT_FRAGMENT_SHADER, /pulse \*= smoothstep\(0\.0, pulseHalfParameter, lightPosition\)/);
  assert.match(FILAMENT_FRAGMENT_SHADER, /v_opacity \* radial \* longitudinal[\s\S]*\* \(1\.0 \+ hot\)/);
});

test("the light fades in at its source and drains before the next cycle", () => {
  const length = 200;
  const cycleMs = (length + flowPulseLengthPx(length)) / FLOW_HEAD_SPEED_PX_S * 1000;
  assert.equal(flowWaveAlpha(0, length, 0, 1, 0.6), 0);
  assert.ok(flowWaveAlpha(10, length, 312.5, 1, 0.6) > 0);
  assert.equal(flowWaveAlpha(length, length, cycleMs - 1, 1, 0.6), 0);
  assert.equal(flowWaveAlpha(0, length, cycleMs, 1, 0.6), 0);
});

test("the pulse advances at D-080 cadence and changes brightness visibly within three seconds", () => {
  const length = 200;
  const times = [2000, 2700, 3400, 4100, 4800];
  const maxima = times.map(now => {
    const samples = Array.from({ length: length + 1 }, (_, x) => flowWaveAlpha(x, length, now, 1, 0.6));
    return samples.indexOf(Math.max(...samples));
  });
  for (let i = 1; i < maxima.length; i++)
    assert.ok(maxima[i]! > maxima[i - 1]!, `pulse failed to advance: ${maxima}`);
  const bright = flowWaveAlpha(maxima[0]!, length, times[0]!, 1, 0.6);
  const later = flowWaveAlpha(maxima[0]!, length, times[1]!, 1, 0.6);
  assert.ok(bright >= 0.6 && bright - later >= 0.4,
    `pulse changed only ${bright - later} of the edge alpha`);
});

test("reduced-motion filament uses a uniform cue rather than a moving envelope", () => {
  assert.match(FILAMENT_FRAGMENT_SHADER, /v_propagationPermille\.z > 0\.0 \? pulse : 0\.35/);
});
