import test from "node:test";
import assert from "node:assert/strict";
import {
  CAMERA_STILLNESS_MS,
  MOVING_DEVICE_PIXEL_RATIO,
  QUALITY_RESTORE_MS,
  QualityGovernor,
  cameraWatchShouldRun,
  capOcclusionSamples,
  occlusionSampleCap,
  perspectiveSizeScale,
  renderPixelScale,
  SIZE_SCALE_EPSILON,
} from "../../src/review/render-schedule.ts";
import {
  FLOW_LAYER_FRAME_MS,
  FLOW_RESUME_FADE_MS,
  flowLayerFrameDue,
  flowLayerResumeAlpha,
  flowLayerShouldRun,
} from "#render-common/flow.ts";

// ---------------------------------------------------------------- quality state machine

test("quality becomes moving on the first camera change and full 200 ms after the last one", () => {
  const governor = new QualityGovernor();
  assert.equal(governor.quality, "full");
  assert.equal(governor.touch(1_000), "moving", "the first change flips quality immediately");
  assert.equal(governor.quality, "moving");
  assert.equal(governor.poll(1_000 + QUALITY_RESTORE_MS - 1), null, "not restored before the delay");
  assert.equal(governor.quality, "moving");
  assert.equal(governor.poll(1_000 + QUALITY_RESTORE_MS), "full", "restored exactly once, 200 ms after the change");
  assert.equal(governor.quality, "full");
  assert.equal(governor.poll(10_000), null, "no second transition while already full");
});

test("each camera change extends the moving window; touch while moving reports no transition", () => {
  const governor = new QualityGovernor();
  assert.equal(governor.touch(0), "moving");
  assert.equal(governor.touch(500), null, "already moving: only the restore deadline moves");
  assert.equal(governor.poll(500 + QUALITY_RESTORE_MS - 1), null, "the first change's deadline is gone");
  assert.equal(governor.poll(500 + QUALITY_RESTORE_MS), "full", "restored relative to the last change");
});

test("a poll older than the last touch never restores quality", () => {
  const governor = new QualityGovernor();
  governor.touch(2_000);
  assert.equal(governor.poll(1_000), null);
  assert.equal(governor.quality, "moving");
  assert.equal(governor.poll(2_000 + QUALITY_RESTORE_MS), "full");
});

test("the restore delay is configurable for tests and tighter loops", () => {
  const governor = new QualityGovernor(50);
  governor.touch(100);
  assert.equal(governor.poll(149), null);
  assert.equal(governor.poll(150), "full");
});

// ---------------------------------------------------------------- flow frame cap and pause conditions

test("flow frames are capped at about 30 fps by timestamp", () => {
  assert.equal(flowLayerFrameDue(10_000, 0), true, "the first frame is always due");
  assert.equal(flowLayerFrameDue(9_950, 10_000), true, "a clock step backwards is due, never a deadlock");
  assert.equal(flowLayerFrameDue(10_033, 10_000), false, "a frame 33 ms after the last one is skipped");
  assert.equal(flowLayerFrameDue(10_000 + FLOW_LAYER_FRAME_MS, 10_000), true, "a frame one interval later is due");
  assert.equal(flowLayerFrameDue(10_100, 10_000), true, "a late frame is due");
  assert.ok(FLOW_LAYER_FRAME_MS >= 1000 / 31 && FLOW_LAYER_FRAME_MS <= 1000 / 29, "the interval is about 30 fps");
});

test("the flow layer pauses unless motion is allowed, the page is visible and an edge animates", () => {
  const base = { allowed: true, hidden: false, animatedEdges: 3 };
  assert.equal(flowLayerShouldRun(base), true);
  assert.equal(flowLayerShouldRun({ ...base, allowed: false }), false, "controls off or reduced motion pause the layer");
  assert.equal(flowLayerShouldRun({ ...base, hidden: true }), false, "a hidden tab pauses the layer");
  assert.equal(flowLayerShouldRun({ ...base, animatedEdges: 0 }), false, "no animated edge left pauses the layer");
  assert.equal(flowLayerShouldRun({ allowed: false, hidden: true, animatedEdges: 0 }), false);
});

test("the resume fade rises smoothly from 0 to 1 and a forced phase never fades", () => {
  assert.equal(flowLayerResumeAlpha(0), 0);
  assert.equal(flowLayerResumeAlpha(FLOW_RESUME_FADE_MS / 2), 0.5);
  assert.equal(flowLayerResumeAlpha(FLOW_RESUME_FADE_MS), 1);
  assert.equal(flowLayerResumeAlpha(10 * FLOW_RESUME_FADE_MS), 1);
  assert.equal(flowLayerResumeAlpha(Number.NaN), 0);
  assert.equal(flowLayerResumeAlpha(50, 0), 1, "a zero fade duration is fully opaque");
});

// ---------------------------------------------------------------- resolution choice

test("the canvas layers cap their backing store at 1.5 at rest and 1.0 while moving", () => {
  assert.equal(renderPixelScale("full", 2), 1.5, "a Retina display rests at 1.5");
  assert.equal(renderPixelScale("moving", 2), MOVING_DEVICE_PIXEL_RATIO, "motion drops the canvas layers to 1.0");
  assert.equal(renderPixelScale("full", 3), 1.5);
  assert.equal(renderPixelScale("full", 1.25), 1.25, "a lower ratio is not raised");
  assert.equal(renderPixelScale("moving", 1.25), 1);
  assert.equal(renderPixelScale("full", 1), 1);
  assert.equal(renderPixelScale("moving", 0.75), 0.75, "a sub-1 display is never raised above its ratio");
  assert.equal(renderPixelScale("full", 0), 1, "an invalid ratio falls back to 1");
  assert.equal(renderPixelScale("full", Number.NaN), 1);
});

// ---------------------------------------------------------------- polling loop start and stop

test("the camera watch runs while pressed, while a motion window is open, or within 300 ms of a change", () => {
  const change = { lastChangeMs: 10_000 as number | null, pressed: false, motionUntilMs: 0 };
  assert.equal(cameraWatchShouldRun({ ...change, nowMs: 10_000, pressed: true }), true, "a pressed pointer keeps the loop");
  assert.equal(cameraWatchShouldRun({ ...change, nowMs: 10_000, motionUntilMs: 10_500 }), true, "an open motion window keeps the loop");
  assert.equal(cameraWatchShouldRun({ ...change, nowMs: 10_299 }), true, "stillness under 300 ms keeps the loop");
  assert.equal(cameraWatchShouldRun({ ...change, nowMs: 10_000 + CAMERA_STILLNESS_MS }), false, "the loop stops at 300 ms of stillness");
  assert.equal(cameraWatchShouldRun({ lastChangeMs: null, nowMs: 10_000, pressed: false, motionUntilMs: 0 }), false, "no change ever observed and nothing pressed: nothing to watch");
});

test("a simulated drag through the watch decision stops the loop 300 ms after the camera settles", () => {
  // Injected clock: the drag changes the camera every frame until t=400, then nothing moves.
  const lastChangeAtFrame = new Map<number, number>();
  for (let t = 0; t <= 400; t += 16) lastChangeAtFrame.set(t, t);
  let lastChangeMs: number | null = null;
  let running = false;
  const framesRunning: boolean[] = [];
  for (let t = 0; t <= 1_000; t += 16) {
    // The loop starts on the pointerdown (a motion window opens) and never before.
    if (t === 0) running = true;
    if (running && lastChangeAtFrame.has(t)) lastChangeMs = t;
    if (running) {
      framesRunning.push(true);
      const pressed = t < 400;
      if (!cameraWatchShouldRun({ nowMs: t + 16, lastChangeMs, pressed, motionUntilMs: t === 0 ? 300 : 0 })) running = false;
    } else framesRunning.push(false);
  }
  assert.equal(framesRunning[0], true, "the loop starts with the interaction");
  assert.equal(framesRunning.at(Math.floor(400 / 16)), true, "still running while the camera moves");
  const stopIndex = framesRunning.findIndex((value, index) => value && !framesRunning[index + 1]);
  const stopTime = stopIndex * 16;
  // The loop stops scheduling once the NEXT frame has no reason to run, so the last running frame
  // sits within one interval of the 300 ms stillness deadline after the t=400 settle.
  assert.ok(stopTime >= 400 + CAMERA_STILLNESS_MS - 17, `stopped no earlier than one frame before the stillness deadline (stopped at ${stopTime} ms)`);
  assert.ok(stopTime <= 400 + CAMERA_STILLNESS_MS + 17, `stopped within one frame of the stillness deadline (stopped at ${stopTime} ms)`);
  assert.equal(framesRunning.at(-1), false, "nothing polls at rest");
});

// ---------------------------------------------------------------- 3D size scale reproduction

test("the pose-reproduced size scale matches the rig's perspective formula, degenerate points included", () => {
  const pose = { position: [0, 0, 10], target: [0, 0, 0] };
  // The camera looks down -z from 10 units away: a point at the target has scale 1, one twice as
  // far doubles the denominator and halves the scale.
  assert.ok(Math.abs(perspectiveSizeScale(pose, { x: 0, y: 0, z: 0 }) - 1) < 1e-12);
  assert.ok(Math.abs(perspectiveSizeScale(pose, { x: 3, y: -2, z: -10 }) - 0.5) < 1e-12, "twice the target depth halves the scale");
  assert.ok(Math.abs(perspectiveSizeScale(pose, { x: 0, y: 0, z: 5 }) - 2) < 1e-12, "half the target depth doubles the scale");
  // At the camera plane both depths floor at the permille epsilon, exactly like the rig.
  const atPlane = perspectiveSizeScale(pose, { x: 0, y: 0, z: 10 });
  assert.ok(Math.abs(atPlane - Math.max(10, SIZE_SCALE_EPSILON) / SIZE_SCALE_EPSILON) < 1e-9);
  const behind = perspectiveSizeScale(pose, { x: 0, y: 0, z: 20 });
  assert.ok(Math.abs(behind - Math.max(10, SIZE_SCALE_EPSILON) / SIZE_SCALE_EPSILON) < 1e-9);
  // An oblique pose keeps the dot-product geometry.
  const oblique = { position: [4, 5, 6], target: [0, 0, 0] };
  const forwardLength = Math.hypot(4, 5, 6);
  const point = { x: -2, y: 1, z: 0.5 };
  const depth = ((point.x - 4) * -4 + (point.y - 5) * -5 + (point.z - 6) * -6) / forwardLength;
  assert.ok(Math.abs(perspectiveSizeScale(oblique, point) - Math.max(forwardLength, SIZE_SCALE_EPSILON) / Math.max(depth, SIZE_SCALE_EPSILON)) < 1e-12);
  assert.equal(perspectiveSizeScale({ position: [0, 0, 0], target: [0, 0, 0] }, point), 1, "a degenerate pose is neutral");
});

// ---------------------------------------------------------------- occlusion cap

test("the occlusion pass is fed at most a budget-scaled set of the nearest anchors", () => {
  assert.equal(occlusionSampleCap(60), 180);
  assert.equal(occlusionSampleCap(4), 96, "a tiny budget still keeps a workable floor");
  const samples = Array.from({ length: 500 }, (_, index) => ({ id: `n${index}`, depth: (index % 7) * 10 + index / 100 }));
  const capped = capOcclusionSamples(samples, 96);
  assert.equal(capped.length, 96);
  const depths = capped.map((sample) => sample.depth);
  assert.deepEqual(depths, [...depths].sort((a, b) => a - b), "the nearest anchors by depth survive");
  const under = capOcclusionSamples(samples.slice(0, 10), 96);
  assert.equal(under.length, 10, "a set under the cap is returned whole");
  assert.notEqual(under, samples.slice(0, 10), "the input array is never returned by reference");
  const tied = capOcclusionSamples([
    { id: "b", depth: 1 }, { id: "a", depth: 1 }, { id: "c", depth: 0 },
  ], 2);
  assert.deepEqual(tied.map((sample) => sample.id), ["c", "a"], "depth ties break by id, deterministically");
});
