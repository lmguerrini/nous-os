import assert from "node:assert/strict";
import test from "node:test";
import { FLOW_BEAM_CORE_MIN_PX, FLOW_BEAM_WHITE_MIX, FLOW_HEAD_MAX_ALPHA,
  FLOW_HEAD_SPEED_PX_S, FLOW_WAVE_MAX_ALPHA, flowBeamLengthPx, flowPulseEnvelope, flowPulseLengthPx,
  flowWaveAlpha } from "#render-common/flow.ts";
import { FILAMENT_FRAGMENT_SHADER } from "#render3f/filament-material.ts";

// D086-F5 BEGIN: restore the D-079 reference build's 82–190 px long, even beam.
test("a still exploratory edge has one smooth, long, homogeneous beam", () => {
  assert.equal(FLOW_HEAD_SPEED_PX_S, 32);
  for (const length of [100, 200, 600]) {
    const width = flowPulseLengthPx(length);
    assert.equal(width, flowBeamLengthPx(length));
    assert.ok(width >= 81 && width <= 191);
    const now = 3000;
    const samples = Array.from({ length: length + 1 }, (_, x) => flowWaveAlpha(x, length, now, 1, 0.6));
    const peaks = samples.slice(1, -1).filter((value, i) => value > samples[i]! && value >= samples[i + 2]!).length;
    assert.ok(peaks <= 1, `${length}px edge has ${peaks} light maxima`);
    assert.ok(samples.every(value => value >= 0 && value <= FLOW_WAVE_MAX_ALPHA));
    for (let i = 1; i < samples.length; i++)
      assert.ok(Math.abs(samples[i]! - samples[i - 1]!) < 0.12, `abrupt step at ${i}`);
  }
  assert.equal(flowPulseEnvelope(0, 120), 1);
  assert.equal(flowPulseEnvelope(40, 120), 1, "the approved beam is even across its core");
  assert.ok(flowPulseEnvelope(56, 120) > 0 && flowPulseEnvelope(56, 120) < 1);
  assert.match(FILAMENT_FRAGMENT_SHADER, /float pulseLengthPx = clamp\(span \/ u_devicePixelRatio \* 0\.476,[\s\S]*81\.6, 190\.4\)/);
  assert.match(FILAMENT_FRAGMENT_SHADER, /smoothstep\(pulseHalfParameter \* 0\.70,/);
  assert.match(FILAMENT_FRAGMENT_SHADER,
    new RegExp(`beamHalfWidth = max\\(bodyHalfWidth,[\\s\\S]*${FLOW_BEAM_CORE_MIN_PX.toFixed(1)}`));
  assert.match(FILAMENT_FRAGMENT_SHADER,
    new RegExp(`alpha = max\\(alpha, beamCoverage \\* ${FLOW_HEAD_MAX_ALPHA.toFixed(2)}\\)`));
  assert.match(FILAMENT_FRAGMENT_SHADER,
    new RegExp(`beamCoverage \\* ${FLOW_BEAM_WHITE_MIX.toFixed(2)}\\)`));
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
  const later = flowWaveAlpha(maxima[0]!, length, times[0]! + 2500, 1, 0.6);
  assert.ok(bright >= 0.6 && bright - later >= 0.4,
    `pulse changed only ${bright - later} of the edge alpha`);
});
// D086-F5 END

test("reduced-motion filament uses a uniform cue rather than a moving envelope", () => {
  assert.match(FILAMENT_FRAGMENT_SHADER, /v_propagationPermille\.z > 0\.0 \? pulse : 0\.35/);
});
